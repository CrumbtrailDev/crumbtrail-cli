using System.Text.RegularExpressions;

namespace Crumbtrail;

public class CaptureContext
{
    public string? SessionId { get; private set; }
    public string? RequestId { get; private set; }
    public bool Active => SessionId is not null && RequestId is not null;
    public List<CaptureEvent> Events { get; } = [];
    public int DroppedEvents { get; private set; }
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public bool Start(string session, string request)
    {
        if (!Regex.IsMatch(session, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") ||
            !Regex.IsMatch(request, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) return false;
        SessionId = session; RequestId = request; return true;
    }
    public void Flush(ICaptureSink sink)
    {
        if (!Active) return;
        if (DroppedEvents > 0) Events.Add(new(Now, "capture_gap", new { kind = "capture_gap", surface = "backend_request", reason = "scan_budget_exceeded", requestId = RequestId, detail = "Event limit reached", droppedEvents = DroppedEvents }));
        try { foreach (var chunk in Events.Chunk(20)) sink.Enqueue(new(SessionId!, chunk)); }
        catch { /* Capture delivery must never fail application work. */ }
        finally { Events.Clear(); DroppedEvents = 0; }
    }
    public void Add(string kind, object payload)
    {
        if (Events.Count < 200) Events.Add(new(Now, kind, payload)); else DroppedEvents++;
    }
}
