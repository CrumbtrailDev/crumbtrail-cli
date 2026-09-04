using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Crumbtrail;

namespace Crumbtrail.Tests;

public sealed class CaptureTests
{
    private static readonly CaptureOptions Options = new(new Uri("https://capture.example"), "test-ingest", "test-api") { ShouldCapture = ctx => ctx.Request.Path.StartsWithSegments("/api") && !ctx.Request.Path.StartsWithSegments("/api/auth") };
    private sealed class Sink : ICaptureSink
    {
        public readonly List<CaptureBatch> Batches = [];
        public void Enqueue(CaptureBatch batch) => Batches.Add(batch);
    }
    private static DefaultHttpContext Request(string path = "/api/probes")
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path; context.Request.Method = "POST";
        context.Request.Headers["x-crumbtrail-session-id"] = "ses_test";
        context.Request.Headers["x-crumbtrail-request-id"] = "0123456789abcdef0123456789abcdef";
        context.Response.Body = new MemoryStream();
        return context;
    }
    [Theory]
    [InlineData("password", "secret")]
    [InlineData("nested", "{\"credentials\":{\"pin\":1234}}")]
    [InlineData("email", "a@example.com")]
    [InlineData("dob", "1990-01-02")]
    [InlineData("value", "4111111111111111")]
    [InlineData("value", "GB29NWBK60161331926819")]
    [InlineData("value", "Jane Smith")]
    public void Structured_body_removes_forbidden_values(string key, string value)
    {
        var input = JsonSerializer.Serialize(new Dictionary<string, object?> { [key] = value, ["amount"] = 18.75, ["unit"] = "CAD", ["entityId"] = 731 });
        var result = StructuredBody.Capture(Encoding.UTF8.GetBytes(input));
        Assert.Equal("redacted", result.State);
        Assert.DoesNotContain(value, result.Body!);
        using var parsed = JsonDocument.Parse(result.Body!);
        Assert.Equal(18.75m, parsed.RootElement.GetProperty("amount").GetDecimal());
        Assert.Equal("CAD", parsed.RootElement.GetProperty("unit").GetString());
        Assert.Equal(731, parsed.RootElement.GetProperty("entityId").GetInt32());
    }
    [Theory]
    [InlineData("{\"amount\":1,\"amount\":2}", "invalid")]
    [InlineData("{\"amount\":", "invalid")]
    [InlineData("", "missing")]
    public void Unusable_json_has_explicit_state(string value, string state)
    {
        var result = StructuredBody.Capture(Encoding.UTF8.GetBytes(value));
        Assert.Equal(state, result.State);
        Assert.Null(result.Body);
    }
    [Fact]
    public void Numeric_cards_and_unsafe_integers_are_withheld_and_placeholders_stay_explicit()
    {
        var result = StructuredBody.Capture(Encoding.UTF8.GetBytes("{\"a\":4111111111111111,\"b\":999999999999999999,\"c\":\"[REDACTED]\",\"amount\":-12.25}"));
        Assert.Equal("redacted", result.State);
        Assert.DoesNotContain("411111", result.Body!);
        Assert.DoesNotContain("999999", result.Body!);
        Assert.Contains("-12.25", result.Body!);
        Assert.Equal("truncated", StructuredBody.Capture(new byte[16385]).State);
    }
    [Fact]
    public void Nested_objects_arrays_and_extreme_numbers_never_expose_credentials()
    {
        const string input = "{\"amount\":18.75,\"nested\":{\"credentials\":{\"pin\":1234},\"amount\":12},\"rows\":[{\"email\":\"a@example.com\",\"amount\":-2.25}],\"extreme\":-79228162514264337593543950335,\"value\":\"sk_test_abcdefghijklmno\"}";
        var result = StructuredBody.Capture(Encoding.UTF8.GetBytes(input));
        Assert.Equal("redacted", result.State);
        foreach (var forbidden in new[] { "1234", "a@example.com", "792281625", "sk_test_" }) Assert.DoesNotContain(forbidden, result.Body!);
        foreach (var operand in new[] { "18.75", "12", "-2.25" }) Assert.Contains(operand, result.Body!);
    }
    [Fact]
    public void Permitted_small_numbers_keep_their_original_json_value()
    {
        var result = StructuredBody.Capture(Encoding.UTF8.GetBytes("{\"amount\":1e-29}"));
        Assert.Equal("captured", result.State);
        Assert.Contains("1e-29", result.Body!);
    }
    [Fact]
    public async Task Export_actual_capture_contract_when_requested()
    {
        var context = Request(); var sink = new Sink();
        const string body = "{\"entityId\":731,\"amount\":18.75,\"unit\":\"CAD\",\"password\":\"never-transmit\",\"contact\":\"a@example.com\",\"cardValue\":4111111111111111}";
        context.Request.ContentType = "application/json";
        // A chunked request has no ContentLength but is still bounded and captured.
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        await new CaptureMiddleware(async ctx =>
        {
            Assert.Equal(body, await new StreamReader(ctx.Request.Body).ReadToEndAsync());
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync("{\"entityId\":731,\"total\":37.5,\"unit\":\"CAD\",\"status\":\"accepted\",\"credentials\":{\"secret\":\"never-transmit-response\"}}");
        }).InvokeAsync(context, new(), Options, sink, NullLogger<CaptureMiddleware>.Instance);
        var batch = Assert.Single(sink.Batches);
        var wire = JsonSerializer.Serialize(batch);
        Assert.DoesNotContain("never-transmit", wire);
        Assert.DoesNotContain("a@example.com", wire);
        Assert.Contains(StructuredBody.Policy, wire);
        var output = Environment.GetEnvironmentVariable("CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT");
        if (output is not null) await File.WriteAllTextAsync(output, wire);
    }
    [Fact]
    public async Task Request_and_response_are_correlated_redacted_and_unchanged_for_app()
    {
        var context = Request(); var sink = new Sink(); var capture = new CaptureContext();
        const string body = "{\"amount\":12,\"password\":\"do-not-capture\",\"nested\":{\"email\":\"a@example.com\"}}";
        context.Request.ContentType = "application/json"; context.Request.ContentLength = Encoding.UTF8.GetByteCount(body);
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        var middleware = new CaptureMiddleware(async ctx =>
        {
            Assert.Equal(body, await new StreamReader(ctx.Request.Body).ReadToEndAsync());
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync("{\"total\":24,\"accessToken\":\"must-not-leak\"}");
        });
        await middleware.InvokeAsync(context,capture,Options,sink,NullLogger<CaptureMiddleware>.Instance);
        var events = Assert.Single(sink.Batches).events;
        Assert.Equal(new[]{"backend.req.start","backend.req.end"},events.Select(e=>e.k));
        var wire = JsonSerializer.Serialize(sink.Batches);
        Assert.Contains("0123456789abcdef0123456789abcdef",wire);
        Assert.DoesNotContain("do-not-capture",wire); Assert.DoesNotContain("must-not-leak",wire); Assert.DoesNotContain("a@example.com",wire);
        using var end = JsonDocument.Parse(JsonSerializer.Serialize(events.Last().d));
        Assert.Equal(200,end.RootElement.GetProperty("statusCode").GetInt32());
        Assert.Contains("24",end.RootElement.GetProperty("responseBody").GetString());
        context.Response.Body.Position=0;
        Assert.Contains("must-not-leak",await new StreamReader(context.Response.Body).ReadToEndAsync());
    }
    [Fact]
    public async Task Auth_and_missing_correlation_do_not_capture()
    {
        foreach(var path in new[]{"/api/auth/login","/api/probes"})
        {
            var context=Request(path); if(path=="/api/probes")context.Request.Headers.Remove("x-crumbtrail-session-id");
            var sink=new Sink();
            await new CaptureMiddleware(ctx=>ctx.Response.WriteAsync("password"))
                .InvokeAsync(context,new(),Options,sink,NullLogger<CaptureMiddleware>.Instance);
            Assert.Empty(sink.Batches);
        }
    }
    [Fact]
    public async Task Large_response_passes_through_without_retaining_partial_json()
    {
        var context=Request();var sink=new Sink();var response="{\"value\":\""+new string('x',20000)+"\"}";
        await new CaptureMiddleware(async ctx=>{ctx.Response.ContentType="application/json";await ctx.Response.WriteAsync(response);})
            .InvokeAsync(context,new(),Options,sink,NullLogger<CaptureMiddleware>.Instance);
        Assert.Equal(Encoding.UTF8.GetByteCount(response),context.Response.Body.Length);
        var last=Assert.Single(sink.Batches).events.Last();using var d=JsonDocument.Parse(JsonSerializer.Serialize(last.d));
        Assert.True(d.RootElement.GetProperty("responseBodyTruncated").GetBoolean());
        Assert.Equal(JsonValueKind.Null,d.RootElement.GetProperty("responseBody").ValueKind);
    }
    [Fact]
    public async Task Duplicate_json_keys_do_not_change_the_application_request()
    {
        var context=Request();var sink=new Sink();const string body="{\"amount\":1,\"amount\":2}";
        context.Request.ContentType="application/json";context.Request.ContentLength=Encoding.UTF8.GetByteCount(body);
        context.Request.Body=new MemoryStream(Encoding.UTF8.GetBytes(body));var reached=false;
        await new CaptureMiddleware(async ctx=>{reached=true;Assert.Equal(body,await new StreamReader(ctx.Request.Body).ReadToEndAsync());})
            .InvokeAsync(context,new(),Options,sink,NullLogger<CaptureMiddleware>.Instance);
        Assert.True(reached);Assert.Equal(200,context.Response.StatusCode);Assert.Single(sink.Batches);
    }
    private sealed class Handler : HttpMessageHandler
    {
        public List<(Uri? Url,string? Auth,string Body)> Calls=[];
        public bool Fail;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Calls.Add((request.RequestUri,request.Headers.Authorization?.ToString(),await request.Content!.ReadAsStringAsync(ct)));
            if(Fail)throw new HttpRequestException("transport unavailable");
            return new(Calls.Count==1?HttpStatusCode.NotFound:HttpStatusCode.OK);
        }
    }
    [Fact]
    public async Task Sender_retries_session_registration_race_with_same_native_envelope()
    {
        var handler=new Handler();using var http=new HttpClient(handler);
        var sender=new CaptureSender(Options,http,NullLogger<CaptureSender>.Instance);
        Assert.True(await sender.SendAsync(new("ses_test",[new(1,"backend.req.end",new{statusCode=200})]),CancellationToken.None));
        Assert.Equal(2,handler.Calls.Count); Assert.All(handler.Calls,c=>Assert.Equal("/api/events",c.Url!.AbsolutePath));
        Assert.All(handler.Calls,c=>Assert.Equal("Bearer test-ingest",c.Auth));
        Assert.Equal(handler.Calls[0].Body,handler.Calls[1].Body);
        Assert.DoesNotContain("test-ingest",handler.Calls[0].Body);
    }
    [Fact]
    public async Task Sender_transport_failures_exhaust_bounded_retries_without_throwing()
    {
        var handler=new Handler{Fail=true};using var http=new HttpClient(handler);
        var sender=new CaptureSender(Options,http,NullLogger<CaptureSender>.Instance);
        Assert.False(await sender.SendAsync(new("ses_test",[]),CancellationToken.None));Assert.Equal(4,handler.Calls.Count);
    }

}
