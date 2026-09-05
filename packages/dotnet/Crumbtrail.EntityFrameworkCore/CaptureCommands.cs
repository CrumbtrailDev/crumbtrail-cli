using Microsoft.Extensions.Logging;
using System.Data.Common;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore.Diagnostics;


namespace Crumbtrail;

public sealed class CaptureCommands(CaptureContext capture) : DbCommandInterceptor
{
    private int sequence;

    // PostgreSQL strings, dollar quoting, comments and bind names are removed before
    // the shape can leave the process. Unrecognized syntax fails closed.
    public static string Shape(string sql)
    {
        // Backslash interpretation depends on PostgreSQL session settings. Withhold
        // the statement rather than parse one interpretation and leak the other.
        if (sql.Contains('\\') || sql.Length > 32768) return "[statement omitted]";
        var output = new System.Text.StringBuilder();
        for (var i = 0; i < sql.Length;)
        {
            var rest = sql.AsSpan(i);
            if (rest.StartsWith("--")) { var end = sql.IndexOf('\n', i); i = end < 0 ? sql.Length : end; output.Append(' '); continue; }
            if (rest.StartsWith("/*"))
            {
                var depth = 1; i += 2;
                while (i < sql.Length && depth > 0)
                { if (sql.AsSpan(i).StartsWith("/*")) { depth++; i += 2; } else if (sql.AsSpan(i).StartsWith("*/")) { depth--; i += 2; } else i++; }
                if (depth != 0) return "[statement omitted]";
                output.Append(' '); continue;
            }
            if (sql[i] == '$')
            {
                var tagLength = DollarTag(rest);
                if (tagLength > 0)
                {
                    var tag = sql.Substring(i, tagLength);
                    var end = sql.IndexOf(tag, i + tagLength, StringComparison.Ordinal);
                    if (end < 0) return "[statement omitted]";
                    i = end + tagLength; output.Append('?'); continue;
                }
            }
            if (sql[i] == '\'')
            {
                i++; var closed = false;
                while (i < sql.Length)
                { if (sql[i] == '\\') { i += 2; continue; } if (sql[i++] != '\'') continue; if (i < sql.Length && sql[i] == '\'') { i++; continue; } closed = true; break; }
                if (!closed) return "[statement omitted]";
                output.Append('?'); continue;
            }
            if (sql[i] == '"')
            {
                var end = sql.IndexOf('"', i + 1); if (end < 0) return "[statement omitted]";
                var name = sql[(i + 1)..end];
                output.Append(Regex.IsMatch(name, @"^[A-Za-z_][A-Za-z0-9_]{0,63}$") ? name : "?"); i = end + 1; continue;
            }
            if (char.IsAsciiDigit(sql[i]) || "@:$".Contains(sql[i]))
            {
                var tokenLength = Literal(rest);
                if (tokenLength > 0) { output.Append('?'); i += tokenLength; continue; }
            }
            if (char.IsAsciiLetter(sql[i]) || sql[i] == '_')
            {
                var word = rest[..Identifier(rest)];
                if (word.Equals("true", StringComparison.OrdinalIgnoreCase) || word.Equals("false", StringComparison.OrdinalIgnoreCase) ||
                    word.Equals("null", StringComparison.OrdinalIgnoreCase)) output.Append('?');
                else output.Append(word);
                i += word.Length; continue;
            }
            if (char.IsWhiteSpace(sql[i]) || "(),.*=<>!+-/%:;[]|&?".Contains(sql[i])) { output.Append(sql[i++]); continue; }
            return "[statement omitted]";
        }
        var shape = Regex.Replace(output.ToString(), @"\s+", " ").Trim();
        return shape.Length <= 2048 ? shape : "[statement omitted]";
    }

    // Scanned over spans rather than matched with Regex: Shape runs on the
    // request path, and a per-token Regex.Match on rest.ToString() copied the
    // remainder of the statement for every token.
    private static int Identifier(ReadOnlySpan<char> rest)
    {
        if (rest.Length == 0 || !(char.IsAsciiLetter(rest[0]) || rest[0] == '_')) return 0;
        var length = 1;
        while (length < rest.Length && (char.IsAsciiLetterOrDigit(rest[length]) || rest[length] == '_')) length++;
        return length;
    }

    // $$ or $tag$, the PostgreSQL dollar quote opener.
    private static int DollarTag(ReadOnlySpan<char> rest)
    {
        if (rest.Length < 2 || rest[0] != '$') return 0;
        var length = 1 + Identifier(rest[1..]);
        return length < rest.Length && rest[length] == '$' ? length + 1 : 0;
    }

    private static bool RadixDigit(char value, int radix) => radix switch
    {
        16 => char.IsAsciiHexDigit(value),
        8 => value is >= '0' and <= '7',
        _ => value is '0' or '1',
    };

    // A bind name (@p0, :p0, $1) or a numeric literal in any of the accepted bases.
    private static int Literal(ReadOnlySpan<char> rest)
    {
        if (rest.Length == 0) return 0;
        if (rest[0] is '@' or ':' or '$')
        {
            var bind = 1;
            while (bind < rest.Length && (char.IsAsciiLetterOrDigit(rest[bind]) || rest[bind] == '_')) bind++;
            return bind > 1 ? bind : 0;
        }
        if (!char.IsAsciiDigit(rest[0])) return 0;
        if (rest.Length > 2 && rest[0] == '0')
        {
            var radix = rest[1] switch { 'x' or 'X' => 16, 'o' or 'O' => 8, 'b' or 'B' => 2, _ => 0 };
            if (radix > 0)
            {
                var based = 2;
                while (based < rest.Length && (rest[based] == '_' || RadixDigit(rest[based], radix))) based++;
                if (based > 2) return based;
            }
        }
        var length = 1;
        while (length < rest.Length && (char.IsAsciiDigit(rest[length]) || rest[length] == '_')) length++;
        if (length < rest.Length && rest[length] == '.')
        {
            var fraction = length + 1;
            while (fraction < rest.Length && (char.IsAsciiDigit(rest[fraction]) || rest[fraction] == '_')) fraction++;
            if (fraction > length + 1) length = fraction;
        }
        if (length < rest.Length && rest[length] is 'e' or 'E')
        {
            var exponent = length + 1;
            if (exponent < rest.Length && rest[exponent] is '+' or '-') exponent++;
            var digits = exponent;
            while (digits < rest.Length && (char.IsAsciiDigit(rest[digits]) || rest[digits] == '_')) digits++;
            if (digits > exponent) length = digits;
        }
        return length;
    }

    private void Record(DbCommand command, CommandEndEventData data, int? rows = null, Exception? error = null)
    {
        if (!capture.Active) return;
        try
        {
            var shape = Shape(command.CommandText);
            var first = shape.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.ToLowerInvariant();
            var op = first is "select" or "insert" or "update" or "delete" ? first : "other";
            var payload = new Dictionary<string, object?> { ["engine"] = data.Context?.Database.ProviderName?.Contains("Npgsql") == true ? "postgres" : "unknown", ["op"] = op,
                ["table"] = null, ["shape"] = shape, ["requestId"] = capture.RequestId,
                ["t"] = CaptureContext.Now, ["durationMs"] = data.Duration.TotalMilliseconds,
                ["seq"] = Interlocked.Increment(ref sequence), ["callsite"] = capture.Callsite?.Invoke() };
            if (error is null)
            { payload["rowCount"] = rows is >= 0 ? rows : null; payload["rowEvidence"] = "not_captured"; }
            else
            { var code = error is DbException dbError && dbError.SqlState is { } state && Regex.IsMatch(state, "^[0-9A-Z]{5}$") ? state : null;
              payload["code"] = code; payload["category"] = code?[..2] switch { "23" => "constraint", "40" => "transaction", "08" => "connection", "42" => "syntax", _ => "unknown" }; payload["errorName"] = error.GetType().Name; }
            capture.Add(error is null ? "db.statement" : "db.error", payload);
        }
        catch { /* Observing a command cannot change its outcome. */ }
    }
    public override DbDataReader ReaderExecuted(DbCommand c, CommandExecutedEventData d, DbDataReader result) { Record(c,d); return result; }
    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand c, CommandExecutedEventData d, DbDataReader result, CancellationToken ct = default) { Record(c,d); return ValueTask.FromResult(result); }
    public override int NonQueryExecuted(DbCommand c, CommandExecutedEventData d, int result) { Record(c,d,result); return result; }
    public override ValueTask<int> NonQueryExecutedAsync(DbCommand c, CommandExecutedEventData d, int result, CancellationToken ct = default) { Record(c,d,result); return ValueTask.FromResult(result); }
    public override object? ScalarExecuted(DbCommand c, CommandExecutedEventData d, object? result) { Record(c,d); return result; }
    public override ValueTask<object?> ScalarExecutedAsync(DbCommand c, CommandExecutedEventData d, object? result, CancellationToken ct = default) { Record(c,d); return ValueTask.FromResult(result); }
    public override void CommandFailed(DbCommand c, CommandErrorEventData d) => Record(c,d,error:d.Exception);
    public override Task CommandFailedAsync(DbCommand c, CommandErrorEventData d, CancellationToken ct = default) { Record(c,d,error:d.Exception); return Task.CompletedTask; }
}
