using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace Crumbtrail;

// The wrapper observes whatever cache the application hands it, so the driver
// name is the caller's to state. It defaults to "unknown" rather than claiming
// Redis.
public sealed class CaptureCache(CaptureContext capture, string driver = "unknown")
{
    private static readonly byte[] HashKey = RandomNumberGenerator.GetBytes(32);
    public async Task<T> Observe<T>(string op, string key, Func<Task<T>> action, Func<T, bool>? hit = null, double? ttlMs = null)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            var result = await action();
            bool? found = null;
            try { if (hit is not null) found = hit(result); } catch { }
            Emit(op,key,started,"success",found,ttlMs,null);
            return result;
        }
        catch (Exception ex) { Emit(op,key,started,"failure",null,ttlMs,ex.GetType().Name); throw; }
    }
    private void Emit(string op, string key, long started, string outcome, bool? hit, double? ttlMs, string? errorName)
    {
        if (!capture.Active) return;
        try
        {
            capture.Add("cache", new { driver, adapter = "manual", op = op is "get" or "set" or "delete" or "exists" or "expire" or "increment" ? op : "other",
                key = "hmac-sha256:" + Convert.ToHexString(HMACSHA256.HashData(HashKey, Encoding.UTF8.GetBytes(key))).ToLowerInvariant(),
                requestId = capture.RequestId, outcome, hit, ttlMs = ttlMs is >= 0 && double.IsFinite(ttlMs.Value) ? ttlMs : null, errorName,
                durationMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds });
        }
        catch { /* Cache evidence must not affect tenant resolution. */ }
    }
}
