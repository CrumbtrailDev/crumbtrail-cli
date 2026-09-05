using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Crumbtrail;

public sealed record CapturedBody(string? Body, string State)
{
    public object RedactionFor(string field) => new { policy = StructuredBody.Policy, fields = State == "redacted"
        ? new[] { new { path = field, reason = "backend_structured_profile", action = "redacted" } }
        : [] };
}

// Structured body policy. The ASP.NET Core, Ruby and Go packages implement the same rules and
// are driven by the same corpus in test-fixtures/backend-body/cases.json, so a divergence
// between them fails a test instead of quietly producing three different bodies.
public static class StructuredBody
{
    public const string Policy = "crumbtrail.backend-redaction.v1";
    public const int MaxBytes = 16384;
    public const int MaxNesting = 8;
    public const int MaxKeys = 64;
    public const int MaxItems = 40;
    // Well below a phone number (10), a national insurance number (9) and a card (13 to 19).
    public const int MaxIntegerDigits = 6;
    public const long SafeInteger = 9007199254740991;
    private const string Redacted = "[REDACTED]";
    private static readonly Regex DeniedName = new("password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson|mobile|contact|diagnosis|medical|patient|prescription|gender|ethnic|religion|salary|income|identifier|username|passport|insurance|beneficiary|guardian|occupation|citizen|latitude|longitude|coordinate|geolocation|province|country|street", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // Short words that appear inside innocent identifiers ("capacity" contains "city"), so they
    // are matched as whole words rather than as substrings.
    private static readonly Regex DeniedWord = new("^(pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf|city|town|geo|cell|race|sex|age|location|lat|lng|lon|gps)s?[0-9]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static bool Sensitive(string key)
    {
        var words = Regex.Replace(key, "([a-z0-9])([A-Z])", "$1 $2");
        var compact = Regex.Replace(key, "[^a-zA-Z0-9]", "");
        return DeniedName.IsMatch(compact) || Regex.Split(words, "[^a-zA-Z0-9]+").Any(DeniedWord.IsMatch);
    }
    // The integer digit cap already excludes every card length. Luhn stays because it also
    // catches a card smuggled across a decimal point, where the integer part is short.
    private static bool SafeNumber(decimal number)
    {
        if (number < -(decimal)SafeInteger || number > (decimal)SafeInteger) return false;
        var text = Math.Abs(number).ToString("0.############################", CultureInfo.InvariantCulture);
        var dot = text.IndexOf('.');
        if ((dot < 0 ? text.Length : dot) > MaxIntegerDigits) return false;
        return !Card(text.Replace(".", ""));
    }
    private static bool Card(string digits)
    {
        if (digits.Length < 13 || digits.Length > 19 || !digits.All(char.IsAsciiDigit)) return false;
        var sum = 0; var twice = false;
        for (var i = digits.Length - 1; i >= 0; i--)
        {
            var n = digits[i] - '0';
            if (twice) { n *= 2; if (n > 9) n -= 9; }
            sum += n; twice = !twice;
        }
        return sum % 10 == 0;
    }
    public static CapturedBody Capture(byte[] bytes, bool truncated = false)
    {
        if (truncated || bytes.Length > MaxBytes) return new(null, "truncated");
        if (bytes.Length == 0) return new(null, "missing");
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = MaxNesting });
            var removed = false;
            var body = JsonSerializer.Serialize(Walk(document.RootElement, "", ref removed));
            if (System.Text.Encoding.UTF8.GetByteCount(body) > MaxBytes) return new(null, "truncated");
            return new(body, removed ? "redacted" : "captured");
        }
        catch (JsonException) { return new(null, "invalid"); }
        catch (InvalidDataException) { return new(null, "invalid"); }
    }
    private static object? Walk(JsonElement value, string key, ref bool removed)
    {
        if (Sensitive(key)) { removed = true; return Redacted; }
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                var result = new Dictionary<string, object?>();
                foreach (var property in value.EnumerateObject())
                {
                    // Reject ambiguous or unbounded objects rather than silently losing operands.
                    if (result.Count >= MaxKeys || result.ContainsKey(property.Name) || property.Name.Length > 64 ||
                        !Regex.IsMatch(property.Name, "^[a-zA-Z_][a-zA-Z0-9_]*$")) throw new InvalidDataException();
                    result.Add(property.Name, Walk(property.Value, property.Name, ref removed));
                }
                return result;
            case JsonValueKind.Array:
                if (value.GetArrayLength() > MaxItems) throw new InvalidDataException();
                var items = new List<object?>();
                foreach (var item in value.EnumerateArray()) items.Add(Walk(item, key, ref removed));
                return items;
            case JsonValueKind.Number:
                if (value.TryGetDecimal(out var number) && SafeNumber(number)) return value.Clone();
                break;
            case JsonValueKind.True: return true;
            case JsonValueKind.False: return false;
            case JsonValueKind.Null: return null;
            case JsonValueKind.String:
                var text = value.GetString()!;
                if (text == Redacted) { removed = true; return Redacted; }
                // This profile keeps short enums, digit identifiers, and explicit ISO currency units.
                // Free text, UUID strings, mixed case credentials, and longer token shapes are withheld.
                if (!Regex.IsMatch(text, "(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][a-zA-Z0-9_.=-]{12,}", RegexOptions.IgnoreCase) &&
                    Regex.IsMatch(text, "^(?:[a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,6})$")) return text;
                break;
        }
        removed = true;
        return Redacted;
    }
}
