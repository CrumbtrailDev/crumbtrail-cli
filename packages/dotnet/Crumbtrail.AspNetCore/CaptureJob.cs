using System.Diagnostics;
namespace Crumbtrail;

public sealed record CaptureParent(string SessionId, string RequestId);

public static class CaptureJob
{
    private static string JobId(string value) => Guid.TryParse(value, out var id) ? id.ToString() : "[REDACTED]";
    public static async Task<T> RunAsync<T>(CaptureContext capture, ICaptureSink sink, CaptureOptions options,
        CaptureParent? parent, string jobId, string job, Func<Task<T>> action)
    {
        // A worker scope owns one correlation. Never overwrite a live request's context.
        if (capture.Active || parent is null || !CaptureContext.ValidId(parent.RequestId) || !capture.Start(parent.SessionId, "job_" + Guid.NewGuid().ToString("N")))
            return await action();
        var started = Stopwatch.GetTimestamp();
        var outcome = "failure";
        capture.Add("backend.job.start", new { requestId = capture.RequestId, parentRequestId = parent.RequestId,
            jobId = JobId(jobId), job = CapturePrivacy.Value("job", job), service = options.Service, sessionId = capture.SessionId });
        try
        {
            var result = await action();
            outcome = "success";
            return result;
        }
        catch (Exception ex)
        {
            outcome = ex is OperationCanceledException ? "cancelled" : "failure";
            capture.Add("backend.job.error", new { requestId = capture.RequestId, parentRequestId = parent.RequestId,
                jobId = JobId(jobId), job = CapturePrivacy.Value("job", job), service = options.Service, error = new { name = ex.GetType().Name } });
            throw;
        }
        finally
        {
            capture.AddTerminal("backend.job.end", new { requestId = capture.RequestId, parentRequestId = parent.RequestId,
                jobId = JobId(jobId), job = CapturePrivacy.Value("job", job), service = options.Service, outcome,
                durationMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
            capture.Flush(sink);
            capture.Stop();
        }
    }
}
