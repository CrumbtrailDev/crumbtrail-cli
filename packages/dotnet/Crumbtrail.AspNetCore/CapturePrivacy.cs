using System.Text.Json;
namespace Crumbtrail;
public static class CapturePrivacy
{
    public static object? Value(string name, object? value)
    {
        try
        {
            if (value is string text && (text.TrimStart().StartsWith('{') || text.TrimStart().StartsWith('[')))
            {
                if (text.Length > StructuredBody.MaxBytes) return "[TRUNCATED]";
                using var parsed = JsonDocument.Parse(text);
                value = parsed.RootElement.Clone();
            }
            var body = StructuredBody.Capture(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?> { [name] = value }));
            if (body.Body is null) return "[REDACTED]";
            using var document = JsonDocument.Parse(body.Body);
            return document.RootElement.GetProperty(name).Clone();
        }
        catch { return "[REDACTED]"; }
    }
}
