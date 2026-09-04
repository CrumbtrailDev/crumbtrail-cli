using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Http;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace Crumbtrail;

public sealed record CaptureEvent(long t, string k, object d);
public sealed record CaptureBatch(string sessionId, IReadOnlyList<CaptureEvent> events);

public sealed record CaptureOptions(Uri? Endpoint, string? Key, string Service)
{
    public bool Enabled => Endpoint is { IsAbsoluteUri: true } && Endpoint.Scheme == "https" &&
        Endpoint.UserInfo == "" && Endpoint.Query == "" && Endpoint.Fragment == "" && !string.IsNullOrWhiteSpace(Key) && !Key.Any(char.IsControl);
    public Func<HttpContext, bool> ShouldCapture { get; init; } = _ => false;
    public static CaptureOptions FromEnvironment(string service)
    {
        var raw = Environment.GetEnvironmentVariable("CRUMBTRAIL_ENDPOINT");
        Uri? endpoint = Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme == "https" &&
            uri.UserInfo == "" && uri.Query == "" && uri.Fragment == "" ? uri : null;
        return new(endpoint, Environment.GetEnvironmentVariable("CRUMBTRAIL_INGEST_KEY"),
            Environment.GetEnvironmentVariable("CRUMBTRAIL_SERVICE") ?? service);
    }
}

public interface ICaptureSink { void Enqueue(CaptureBatch batch); }

public sealed class CaptureSender(CaptureOptions options, HttpClient http, ILogger<CaptureSender> log)
    : BackgroundService, ICaptureSink
{
    private readonly Channel<CaptureBatch> queue = Channel.CreateBounded<CaptureBatch>(new BoundedChannelOptions(64)
        { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });

    public void Enqueue(CaptureBatch batch)
    {
        if (options.Enabled && !queue.Writer.TryWrite(batch)) log.LogWarning("Crumbtrail capture queue is full; request evidence was dropped");
    }

    public async Task<bool> SendAsync(CaptureBatch batch, CancellationToken ct)
    {
        if (!options.Enabled) return false;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(options.Endpoint!, "/api/events"));
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Key);
                request.Content = JsonContent.Create(batch);
                using var response = await http.SendAsync(request, ct);
                if (response.StatusCode == System.Net.HttpStatusCode.OK) return true;
                // The browser can send correlation headers before its session registration finishes.
                if (response.StatusCode != System.Net.HttpStatusCode.NotFound &&
                    response.StatusCode != System.Net.HttpStatusCode.TooManyRequests && (int)response.StatusCode < 500)
                {
                    log.LogWarning("Crumbtrail rejected request evidence with status {Status}", (int)response.StatusCode);
                    return false;
                }
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
            {
                if (ct.IsCancellationRequested) return false;
            }
            if (attempt < 3) await Task.Delay(TimeSpan.FromMilliseconds(250 * (attempt + 1)), ct);
        }
        log.LogWarning("Crumbtrail request evidence delivery exhausted its retry budget");
        return false;
    }

    public override void Dispose()
    {
        http.Dispose();
        base.Dispose();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var batch in queue.Reader.ReadAllAsync(stoppingToken)) await SendAsync(batch, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}

