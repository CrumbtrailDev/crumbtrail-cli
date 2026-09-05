using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
namespace Crumbtrail.Tests;

public sealed class RequestSafetyTests
{
    private sealed class Sink : ICaptureSink { public List<CaptureEvent> Events = []; public void Enqueue(CaptureBatch batch) => Events.AddRange(batch.events); }
    private static DefaultHttpContext Context()
    {
        var context = new DefaultHttpContext(); context.Request.Path = "/reset/private-token";
        context.Request.Headers["x-crumbtrail-session-id"] = "ses_test"; context.Request.Headers["x-crumbtrail-request-id"] = "req_test";
        context.Response.Body = new MemoryStream(); return context;
    }
    private static CaptureOptions Options = new(new Uri("https://capture.example"), "key", "test") { ShouldCapture = _ => true };
    [Theory]
    [InlineData(false, "/reset/[REDACTED]")]
    [InlineData(true, "/reset/{token}")]
    public async Task Routes_never_export_raw_path_values(bool matched, string route)
    {
        var context = Context(); var sink = new Sink();
        if (matched) context.SetEndpoint(new RouteEndpoint(_ => Task.CompletedTask, RoutePatternFactory.Parse(route), 0, EndpointMetadataCollection.Empty, "reset"));
        await new CaptureMiddleware(http => { Assert.Equal("/reset/private-token", http.Request.Path.Value); return Task.CompletedTask; })
            .InvokeAsync(context, new(), Options, sink, NullLogger<CaptureMiddleware>.Instance);
        var wire = JsonSerializer.Serialize(sink.Events); Assert.DoesNotContain("private-token", wire);
        foreach (var item in sink.Events)
        {
            var data = JsonSerializer.SerializeToElement(item.d);
            Assert.Equal("/reset/[REDACTED]", data.GetProperty("url").GetString());
            Assert.Equal("/reset/[REDACTED]", data.GetProperty("pathname").GetString());
            Assert.Equal(route, data.GetProperty("route").GetString());
        }
    }

    [Theory]
    [InlineData("/", "/")]
    [InlineData("/api/auth/whoami", "/api/auth/whoami")]
    [InlineData("/orders/1042", "/orders/1042")]
    [InlineData("/static/app.css", "/static/app.css")]
    [InlineData("/session/8f14e45fceea167a5a36dedd4bea2543", "/session/[REDACTED]")]
    [InlineData("/files/be3ac089-71fe-4dda-ae99-6403ec2dba82", "/files/[REDACTED]")]
    [InlineData("/reset/private-token", "/reset/[REDACTED]")]
    public void Unmatched_paths_keep_route_shape_without_exporting_values(string path, string expected)
        => Assert.Equal(expected, CapturePath.Scrub(path));

    [Fact]
    public async Task Unmatched_requests_report_their_own_path()
    {
        var context = Context(); context.Request.Path = "/no/such/page"; var sink = new Sink();
        await new CaptureMiddleware(http => { http.Response.StatusCode = 404; return Task.CompletedTask; })
            .InvokeAsync(context, new(), Options, sink, NullLogger<CaptureMiddleware>.Instance);
        var data = JsonSerializer.SerializeToElement(Assert.Single(sink.Events, e => e.k == "backend.req.end").d);
        Assert.Equal("/no/such/page", data.GetProperty("url").GetString());
        Assert.Equal("/no/such/page", data.GetProperty("route").GetString());
        Assert.Equal(404, data.GetProperty("statusCode").GetInt32());
    }
    [Fact]
    public async Task Short_request_is_withheld_without_changing_bytes_read_by_application()
    {
        var context = Context(); var sink = new Sink(); context.Request.ContentType = "application/json"; context.Request.ContentLength = 4;
        context.Request.Body = new MemoryStream("1"u8.ToArray());
        await new CaptureMiddleware(async http => Assert.Equal("1", await new StreamReader(http.Request.Body).ReadToEndAsync()))
            .InvokeAsync(context, new(), Options, sink, NullLogger<CaptureMiddleware>.Instance);
        var data = JsonSerializer.SerializeToElement(Assert.Single(sink.Events, e => e.k == "backend.req.start").d);
        Assert.Equal("truncated", data.GetProperty("requestBodyState").GetString()); Assert.Equal(JsonValueKind.Null, data.GetProperty("body").ValueKind);
    }
    [Fact]
    public async Task Throwing_predicate_preserves_application_result()
    {
        var context = Context(); var sink = new Sink(); var reached = false;
        await new CaptureMiddleware(_ => { reached = true; return Task.CompletedTask; })
            .InvokeAsync(context, new(), Options with { ShouldCapture = _ => throw new Exception("private") }, sink, NullLogger<CaptureMiddleware>.Instance);
        Assert.True(reached); Assert.Empty(sink.Events);
    }
    private sealed class StartedResponse : IHttpResponseFeature
    {
        public int StatusCode { get; set; } = 202;
        public string? ReasonPhrase { get; set; }
        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
        public Stream Body { get; set; } = new MemoryStream();
        public bool HasStarted => true;
        public void OnStarting(Func<object, Task> callback, object state) { }
        public void OnCompleted(Func<object, Task> callback, object state) { }
    }
    [Fact]
    public async Task Failure_after_headers_preserves_status_and_original_error()
    {
        var context = Context(); context.Features.Set<IHttpResponseFeature>(new StartedResponse()); var sink = new Sink();
        var error = new InvalidOperationException("private-error");
        Assert.Same(error, await Assert.ThrowsAsync<InvalidOperationException>(() => new CaptureMiddleware(_ => throw error)
            .InvokeAsync(context, new(), Options, sink, NullLogger<CaptureMiddleware>.Instance)));
        var data = JsonSerializer.SerializeToElement(Assert.Single(sink.Events, e => e.k == "backend.req.end").d);
        Assert.Equal(202, data.GetProperty("statusCode").GetInt32()); Assert.DoesNotContain("private-error", JsonSerializer.Serialize(sink.Events));
    }
}
