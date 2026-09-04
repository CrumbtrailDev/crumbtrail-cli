using System.Text.Json;
namespace Crumbtrail;
public static class CapturePrivacy
{
    public static object? PrimaryKey(string name, object? value)
        => value is Guid id && !StructuredBody.Sensitive(name) ? id.ToString() : Value(name, value);
    public static object? Value(string name, object? value)
    {
        try
        {
            if (value is string bounded && bounded.Length > StructuredBody.MaxBytes) return "[TRUNCATED]";
            if (value is not (null or string or JsonElement or bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal or Guid or DateTime or DateTimeOffset or DateOnly or TimeOnly)) return "[REDACTED]";
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
