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
        if (sql.Length > 32768) return "[statement omitted]";
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
                var tag = Regex.Match(rest.ToString(), @"^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$");
                if (tag.Success)
                { var end = sql.IndexOf(tag.Value, i + tag.Length, StringComparison.Ordinal); if (end < 0) return "[statement omitted]"; i = end + tag.Length; output.Append('?'); continue; }
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
                var token = Regex.Match(rest.ToString(), @"^(?:[@:$][A-Za-z0-9_]+|0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)");
                if (token.Success) { output.Append('?'); i += token.Length; continue; }
            }
            if (char.IsAsciiLetter(sql[i]) || sql[i] == '_')
            { var word = Regex.Match(rest.ToString(), @"^[A-Za-z_][A-Za-z0-9_]*").Value; output.Append(word.ToLowerInvariant() is "true" or "false" or "null" ? "?" : word); i += word.Length; continue; }
            if (char.IsWhiteSpace(sql[i]) || "(),.*=<>!+-/%:;[]|&?".Contains(sql[i])) { output.Append(sql[i++]); continue; }
            return "[statement omitted]";
        }
        var shape = Regex.Replace(output.ToString(), @"\s+", " ").Trim();
        return shape.Length <= 2048 ? shape : "[statement omitted]";
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
            { payload["code"] = error is DbException dbError ? dbError.SqlState : null; payload["category"] = "unknown"; payload["errorName"] = error.GetType().Name; }
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
