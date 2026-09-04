using System.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Routing;

namespace Crumbtrail;

public sealed class CaptureMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, CaptureContext capture, CaptureOptions options,
        ICaptureSink sink, ILogger<CaptureMiddleware> log)
    {
        if (!options.Enabled || !options.ShouldCapture(context) ||
            !capture.Start(context.Request.Headers["x-crumbtrail-session-id"].ToString(),
                context.Request.Headers["x-crumbtrail-request-id"].ToString()))
        { await next(context); return; }

        var path = context.Request.Path.Value ?? "/";
        var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? path;
        var watch = Stopwatch.StartNew();
        var requestBody = new CapturedBody(null, "missing");
        if (context.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true &&
            context.Request.ContentLength is null or > 0)
        {
            try
            {
                context.Request.EnableBuffering();
                var bytes = new byte[16385];
                var count = 0;
                while (count < bytes.Length)
                {
                    var read = await context.Request.Body.ReadAsync(bytes.AsMemory(count), context.RequestAborted);
                    if (read == 0) break;
                    count += read;
                }
                requestBody = StructuredBody.Capture(bytes[..count]);
            }
            catch { log.LogWarning("Crumbtrail could not capture the request body"); }
            finally { if (context.Request.Body.CanSeek) context.Request.Body.Position = 0; }
        }
        var correlation = new { status = "linked", sessionIdSource = "header", requestIdSource = "header" };
        capture.Add("backend.req.start", new { requestId = capture.RequestId, sessionId = capture.SessionId,
            method = context.Request.Method, url = path, pathname = path, route, correlation, service = options.Service,
            body = requestBody.Body, requestBodyState = requestBody.State, redaction = requestBody.Redaction });
        var original = context.Response.Body;
        var tee = new ResponseTee(original);
        context.Response.Body = tee;
        Exception? failure = null;
        try { await next(context); }
        catch (Exception e) { failure = e; throw; }
        finally
        {
            context.Response.Body = original;
            try
            {
                var responseBody = context.Response.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true
                    ? StructuredBody.Capture(tee.Captured.ToArray(), tee.Truncated) : new CapturedBody(null, "missing");
                if (failure is not null) capture.Add("backend.req.error", new { requestId = capture.RequestId,
                    sessionId = capture.SessionId, method = context.Request.Method, url = path, route,
                    error = new { name = failure.GetType().Name }, correlation });
                capture.Events.Add(new(CaptureContext.Now, "backend.req.end", new { requestId = capture.RequestId,
                    sessionId = capture.SessionId, method = context.Request.Method, url = path, pathname = path, route,
                    statusCode = failure is null ? context.Response.StatusCode : 500,
                    durationMs = watch.Elapsed.TotalMilliseconds, responseBody = responseBody.Body, responseBodyTruncated = tee.Truncated,
                    responseBodyState = responseBody.State, redaction = responseBody.Redaction,
                    correlation, service = options.Service }));
                if (capture.DroppedEvents > 0) log.LogWarning("Crumbtrail request exceeded capture limit; {Count} events omitted", capture.DroppedEvents);
                capture.Flush(sink);
            }
            catch { log.LogWarning("Crumbtrail could not prepare request evidence"); }
            tee.Captured.Dispose();
        }
    }

    private sealed class ResponseTee(Stream inner) : Stream
    {
        public MemoryStream Captured { get; } = new();
        public bool Truncated { get; private set; }
        private void Keep(ReadOnlySpan<byte> bytes)
        {
            var remaining = 16384 - (int)Captured.Length;
            Captured.Write(bytes[..Math.Min(remaining, bytes.Length)]);
            Truncated |= bytes.Length > remaining;
        }
        public override void Write(byte[] buffer, int offset, int count) { inner.Write(buffer, offset, count); Keep(buffer.AsSpan(offset,count)); }
        public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
        { await inner.WriteAsync(buffer.AsMemory(offset,count),ct); Keep(buffer.AsSpan(offset,count)); }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
        { await inner.WriteAsync(buffer,ct); Keep(buffer.Span); }
        public override void Flush() => inner.Flush();
        public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => inner.CanWrite;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer,int offset,int count) => throw new NotSupportedException();
        public override long Seek(long offset,SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
