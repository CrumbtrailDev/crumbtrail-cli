using System.Text.Json;
using Xunit;
namespace Crumbtrail.Tests;

public sealed class AdapterTests
{
    private sealed class Sink : ICaptureSink { public List<CaptureEvent> Events = []; public void Enqueue(CaptureBatch batch) => Events.AddRange(batch.events); }
    private static CaptureOptions Options = new(new Uri("https://capture.example"), "test", "worker");
    [Theory]
    [InlineData("routingNumber", "123456789")]
    [InlineData("tax_id", "123456789")]
    [InlineData("secret", "plain")]
    [InlineData("other", "private mixed TEXT")]
    public void Database_values_use_the_conservative_profile(string key, string value)
    { Assert.DoesNotContain(value, JsonSerializer.Serialize(CapturePrivacy.Value(key, value))); }

    [Fact]
    public async Task Concurrent_cache_events_are_bounded_and_keys_are_not_guessable_sha256()
    {
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        var cache = new CaptureCache(capture);
        await Task.WhenAll(Enumerable.Range(0, 250).Select(i => Task.Run(() => cache.Observe("get", "private-key", () => Task.FromResult("private-value"), x => true))));
        Assert.Equal(200, capture.Events.Count); Assert.Equal(50, capture.DroppedEvents);
        var wire = JsonSerializer.Serialize(capture.Events);
        Assert.Contains("hmac-sha256:", wire); Assert.DoesNotContain("private-key", wire); Assert.DoesNotContain("private-value", wire);
        // A generic wrapper does not know which cache it observes.
        Assert.Contains("\"driver\":\"unknown\"", wire);
    }

    [Fact]
    public async Task Cache_capture_failure_preserves_original_result_and_exception()
    {
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        var cache = new CaptureCache(capture);
        Assert.Equal(42, await cache.Observe("get", "key", () => Task.FromResult(42), _ => throw new Exception("private")));
        var failure = new InvalidOperationException("private");
        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(() => cache.Observe<int>("get", "key", () => throw failure)));
        Assert.DoesNotContain("private", JsonSerializer.Serialize(capture.Events));
    }

    [Fact]
    public async Task Jobs_get_distinct_requests_preserve_parent_and_reset_scope_after_failure()
    {
        var capture = new CaptureContext(); var sink = new Sink(); var requests = new List<string>();
        for (var i = 0; i < 2; i++)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => CaptureJob.RunAsync<int>(capture, sink, Options,
                new("ses_parent", "req_parent"), Guid.NewGuid().ToString(), "calculation", () => { requests.Add(capture.RequestId!); throw new InvalidOperationException("private-message"); }));
            Assert.False(capture.Active);
        }
        Assert.NotEqual(requests[0], requests[1]); Assert.DoesNotContain("req_parent", requests);
        Assert.Equal(6, sink.Events.Count); var wire = JsonSerializer.Serialize(sink.Events);
        Assert.Contains("\"parentRequestId\":\"req_parent\"", wire); Assert.DoesNotContain("private-message", wire);
    }
    [Fact]
    public async Task Invalid_parent_never_captures_or_prevents_work()
    {
        var capture = new CaptureContext(); var sink = new Sink();
        Assert.Equal(7, await CaptureJob.RunAsync(capture, sink, Options, new("ses_valid", "invalid parent"), "id", "test", () => Task.FromResult(7)));
        Assert.Empty(sink.Events); Assert.False(capture.Active);
    }
    [Fact]
    public void Callsites_map_debug_symbols_to_repository_paths()
    {
        var callsite = CaptureCallsite.Create("/Crumbtrail.AspNetCore.Tests/", "tests/")();
        var json = JsonSerializer.SerializeToElement(callsite);
        Assert.Equal("tests/AdapterTests.cs", json.GetProperty("file").GetString());
        Assert.True(json.GetProperty("line").GetInt32() > 0);
        Assert.Null(CaptureCallsite.Create("/missing_source_marker/", "src/")());
    }
    [Fact]
    public void Typed_primary_key_exception_does_not_apply_to_sensitive_names_or_body_strings()
    {
        var id = Guid.NewGuid();
        Assert.Equal(id.ToString(), CapturePrivacy.PrimaryKey("id", id));
        Assert.DoesNotContain(id.ToString(), JsonSerializer.Serialize(CapturePrivacy.PrimaryKey("access_token", id)));
        Assert.DoesNotContain(id.ToString(), JsonSerializer.Serialize(CapturePrivacy.Value("id", id.ToString())));
        Assert.DoesNotContain(id.ToString(), StructuredBody.Capture(JsonSerializer.SerializeToUtf8Bytes(new { id = id.ToString() })).Body);
    }
}
