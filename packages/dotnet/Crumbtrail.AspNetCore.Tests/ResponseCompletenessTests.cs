using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
namespace Crumbtrail.Tests;

public sealed class ResponseCompletenessTests
{
    private sealed class Sink : ICaptureSink { public List<CaptureEvent> Events = []; public void Enqueue(CaptureBatch batch) => Events.AddRange(batch.events); }
    [Theory]
    [InlineData("GET", 200, 4, "truncated")]
    [InlineData("GET", 200, 0, "truncated")]
    [InlineData("GET", 200, 1, "captured")]
    [InlineData("HEAD", 200, 4, "missing")]
    [InlineData("GET", 204, 4, "missing")]
    [InlineData("GET", 205, 4, "missing")]
    [InlineData("GET", 304, 4, "missing")]
    [InlineData("GET", 103, 4, "missing")]
    public async Task Only_complete_permitted_response_bodies_are_retained(string method, int status, long declared, string state)
    {
        var context = new DefaultHttpContext(); context.Request.Method = method;
        context.Request.Headers["x-crumbtrail-session-id"] = "ses_test";
        context.Request.Headers["x-crumbtrail-request-id"] = "req_test";
        context.Response.Body = new MemoryStream();
        var sink = new Sink();
        var options = new CaptureOptions(new Uri("https://capture.example"), "key", "test") { ShouldCapture = _ => true };
        await new CaptureMiddleware(async http =>
        {
            http.Response.StatusCode = status; http.Response.ContentType = "application/json"; http.Response.ContentLength = declared;
            await http.Response.Body.WriteAsync("1"u8.ToArray());
        }).InvokeAsync(context, new CaptureContext(), options, sink, NullLogger<CaptureMiddleware>.Instance);
        Assert.Equal("1", System.Text.Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray()));
        var data = JsonSerializer.SerializeToElement(Assert.Single(sink.Events, e => e.k == "backend.req.end").d);
        Assert.Equal(state, data.GetProperty("responseBodyState").GetString());
        Assert.Equal(state == "truncated", data.GetProperty("responseBodyTruncated").GetBoolean());
        Assert.Equal(state == "captured" ? "1" : null, data.GetProperty("responseBody").GetString());
    }
}
