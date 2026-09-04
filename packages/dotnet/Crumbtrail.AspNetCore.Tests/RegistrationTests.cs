using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Crumbtrail.Tests;

public sealed class RegistrationTests
{
    private sealed class Sink : ICaptureSink
    {
        public List<CaptureBatch> Batches { get; } = [];
        public void Enqueue(CaptureBatch batch) => Batches.Add(batch);
    }

    [Fact]
    public async Task Registered_package_captures_real_http_without_changing_application_bytes()
    {
        var builder = WebApplication.CreateBuilder();
        var sink = new Sink();
        builder.Services.AddCrumbtrail(new(new Uri("https://capture.example"), "test-key", "test-api")
        { ShouldCapture = ctx => ctx.Request.Path.StartsWithSegments("/orders") });
        builder.Services.AddSingleton<ICaptureSink>(sink);
        await using var app = builder.Build();
        app.Urls.Add("http://127.0.0.1:0");
        app.UseRouting();
        app.UseCrumbtrail();
        app.MapPost("/orders", async ctx =>
        {
            ctx.Response.ContentType = "application/problem+json";
            await ctx.Request.Body.CopyToAsync(ctx.Response.Body);
        });
        await app.StartAsync();
        try
        {
            using var client = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, app.Urls.Single() + "/orders");
            request.Headers.Add("x-crumbtrail-session-id", "ses_registration");
            request.Headers.Add("x-crumbtrail-request-id", "req_registration");
            const string body = "{\"amount\":18.75,\"password\":\"private-value\"}";
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(body, await response.Content.ReadAsStringAsync());
            var wire = JsonSerializer.Serialize(Assert.Single(sink.Batches));
            Assert.Contains("18.75", wire);
            Assert.DoesNotContain("private-value", wire);
            Assert.Contains("backend.req.start", wire);
            Assert.Contains("backend.req.end", wire);
        }
        finally { await app.StopAsync(); }
    }

    [Fact]
    public async Task Default_route_policy_skips_all_capture()
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["x-crumbtrail-session-id"] = "ses_test";
        context.Request.Headers["x-crumbtrail-request-id"] = "req_test";
        var sink = new Sink();
        var called = false;
        await new CaptureMiddleware(_ => { called = true; return Task.CompletedTask; })
            .InvokeAsync(context, new(), new(new Uri("https://capture.example"), "test", "api"), sink, NullLogger<CaptureMiddleware>.Instance);
        Assert.True(called);
        Assert.Empty(sink.Batches);
    }

    [Theory]
    [InlineData("http://capture.example")]
    [InlineData("https://user:password@capture.example")]
    [InlineData("https://capture.example?key=secret")]
    [InlineData("/relative")]
    public void Invalid_endpoints_disable_capture(string endpoint)
        => Assert.False(new CaptureOptions(new Uri(endpoint, UriKind.RelativeOrAbsolute), "test", "api").Enabled);

    [Theory]
    [InlineData("routingNumber")]
    [InlineData("taxId")]
    [InlineData("nationalId")]
    [InlineData("sortCode")]
    public void Financial_identifiers_are_withheld_before_delivery(string key)
    {
        var body = StructuredBody.Capture(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Dictionary<string, object> { [key] = 123456789, ["amount"] = 42 })));
        Assert.DoesNotContain("123456789", body.Body);
        Assert.Contains("42", body.Body);
        Assert.Equal("redacted", body.State);
    }
}
