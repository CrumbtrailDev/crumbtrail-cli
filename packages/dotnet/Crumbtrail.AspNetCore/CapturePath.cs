using System.Text.RegularExpressions;

namespace Crumbtrail;

/// <summary>
/// Reduces a request path to route vocabulary so a captured request still says
/// which path it hit. Mirrors the Node SDK's <c>redactUrl</c> path handling:
/// redact the segments that can carry a value, keep the segments that name a
/// route. Discarding the whole path instead makes every 404 and every static
/// request identical on the wire, which is worse evidence than a redacted
/// segment.
/// </summary>
public static class CapturePath
{
    private const string Redacted = "[REDACTED]";
    private const int MaxLength = 1024;

    // A short lowercase word is route vocabulary rather than a value, so it
    // survives even after a sensitive preceder: `/api/auth/whoami` must still
    // name its endpoint. Deliberately narrow, because it weakens a redaction
    // control - anything with entropy carries mixed case, digits or separators
    // and fails to match.
    private static readonly Regex RouteWord = new("^(?:[a-z]{1,16}|v[0-9]{1,3})$", RegexOptions.CultureInvariant);

    // Everything else must look like route vocabulary too: a word, a numeric
    // id, or a simple file name. Tokens, uuids, hashes and base64 fragments
    // fail at least one of those and are withheld.
    private static readonly Regex RouteSegment = new(@"^(?:[A-Za-z][A-Za-z_-]{0,31}(?:\.[A-Za-z][A-Za-z0-9]{0,7})?|[0-9]{1,12})$", RegexOptions.CultureInvariant);

    public static string Scrub(string? path)
    {
        if (string.IsNullOrEmpty(path)) return "/";
        if (path.Length > MaxLength) return "/" + Redacted;
        var segments = path.Split('/');
        var afterSensitive = false;
        for (var i = 0; i < segments.Length; i++)
        {
            var segment = segments[i];
            if (segment.Length == 0) continue;
            var routeWord = RouteWord.IsMatch(segment);
            var sensitive = StructuredBody.Sensitive(segment);
            if (!routeWord && (sensitive || afterSensitive || !RouteSegment.IsMatch(segment))) segments[i] = Redacted;
            afterSensitive = sensitive;
        }
        var scrubbed = string.Join('/', segments);
        return scrubbed.StartsWith('/') ? scrubbed : "/" + scrubbed;
    }
}
