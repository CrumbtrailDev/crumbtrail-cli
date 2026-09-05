using System.Text.RegularExpressions;

namespace Crumbtrail;

public class CaptureContext
{
    public Func<object?>? Callsite { get; set; }
    private readonly object gate = new();
    public string? SessionId { get; private set; }
    public string? RequestId { get; private set; }
    public bool Active => SessionId is not null && RequestId is not null;
    private readonly List<CaptureEvent> events = [];
    public IReadOnlyList<CaptureEvent> Events { get { lock (gate) return events.ToArray(); } }
    public int DroppedEvents { get; private set; }
    private int terminal = -1;
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public static bool ValidId(string? value) => value is not null && Regex.IsMatch(value, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
    public bool Start(string session, string request)
    {
        lock (gate)
        {
            if (Active || !ValidId(session) || !ValidId(request)) return false;
            SessionId = session; RequestId = request; return true;
        }
    }
    public void Stop()
    {
        lock (gate) { SessionId = null; RequestId = null; events.Clear(); DroppedEvents = 0; terminal = -1; }
    }
    public void Flush(ICaptureSink sink)
    {
        CaptureEvent[] batch;
        string session;
        lock (gate)
        {
            if (!Active) return;
            session = SessionId!;
            if (DroppedEvents > 0)
            {
                // The marker describes the request it belongs to, so it has to
                // arrive before that request's terminal event, not after it.
                var gap = new CaptureEvent(Now, "capture_gap", new { kind = "capture_gap", surface = "backend_request", reason = "scan_budget_exceeded", requestId = RequestId, detail = "Event limit reached", droppedEventCount = DroppedEvents });
                if (terminal >= 0 && terminal <= events.Count) events.Insert(terminal, gap); else events.Add(gap);
            }
            batch = events.ToArray(); events.Clear(); DroppedEvents = 0; terminal = -1;
        }
        try { foreach (var chunk in batch.Chunk(20)) sink.Enqueue(new(session, chunk)); }
        catch { /* Capture delivery must never fail application work. */ }
    }
    internal void AddTerminal(string kind, object payload)
    {
        lock (gate) { if (!Active) return; terminal = events.Count; events.Add(new(Now, kind, payload)); }
    }
    public void Add(string kind, object payload)
    {
        lock (gate)
        {
            if (!Active) return;
            if (events.Count < 200) events.Add(new(Now, kind, payload)); else DroppedEvents++;
        }
    }
}
