using System.Transactions;
using Microsoft.Extensions.Logging;
using System.Data.Common;
using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crumbtrail;

public sealed class CapturedChanges(CaptureContext capture, ILogger<CapturedChanges> log) : IDisposable
{
    private sealed record Pending(EntityEntry Entry, string Table, string Operation, object? Before, object? Callsite);
    private readonly Dictionary<DbContext, (List<Pending> Rows, long Started)> pending = [];
    private readonly Dictionary<Guid, List<object>> transactions = [];

    private readonly object gate = new();
    public void Dispose() { lock (gate) { pending.Clear(); transactions.Clear(); } }
    public void Before(DbContext? db) { lock (gate) BeforeCore(db); }
    public void After(DbContext? db) { lock (gate) AfterCore(db); }
    public void Failed(DbContext? db) { lock (gate) { if (db is not null) pending.Remove(db); } }
    public void Complete(Guid id, bool committed) { lock (gate) CompleteCore(id, committed); }
    public void SavepointRollback(Guid id)
    {
        lock (gate)
        {
            if (transactions.Remove(id)) capture.Add("capture_gap", new { surface = "db_diff", reason = "savepoint_rollback", requestId = capture.RequestId });
        }
    }
    private void BeforeCore(DbContext? db)
    {
        if (!capture.Active || db is null) return;
        pending.Remove(db);
        try
        {
            if (System.Transactions.Transaction.Current is not null || db.Database.GetEnlistedTransaction() is not null)
            {
                capture.Add("capture_gap", new { surface = "db_diff", reason = "unsupported_transaction", requestId = capture.RequestId });
                return;
            }
            var entries = db.ChangeTracker.Entries().Where(e => e.State is EntityState.Added or EntityState.Modified or EntityState.Deleted).ToList();
            if (entries.Count > 100)
            {
                log.LogWarning("Crumbtrail database snapshot limit omitted {Count} tracked rows", entries.Count - 100);
                capture.Add("capture_gap", new { kind = "capture_gap", surface = "db_diff", reason = "scan_budget_exceeded", requestId = capture.RequestId, detail = "Tracked row snapshot limit reached", omittedRows = entries.Count - 100 });
            }
            var bounded = entries.Take(100).Where(e =>
            {
                if (e.Properties.Take(65).Count() <= 64) return true;
                capture.Add("capture_gap", new { surface = "db_diff", reason = "property_budget_exceeded", requestId = capture.RequestId });
                return false;
            });
            var rows = bounded.Select(e => new Pending(e, e.Metadata.GetTableName() ?? e.Metadata.ClrType.Name,
                    e.State == EntityState.Added ? "insert" : e.State == EntityState.Deleted ? "delete" : "update",
                    e.State == EntityState.Added ? null : Row(e, true), capture.Callsite?.Invoke())).ToList();
            pending[db] = (rows, Stopwatch.GetTimestamp());
        }
        catch { capture.Add("capture_gap", new { surface = "db_diff", reason = "snapshot_failed", requestId = capture.RequestId }); log.LogWarning("Crumbtrail could not snapshot pending database changes"); }
    }
    private void AfterCore(DbContext? db)
    {
        if (db is null || !pending.Remove(db, out var saved)) return;
        try
        {
            var tx = db.Database.CurrentTransaction?.TransactionId;
            foreach (var row in saved.Rows)
            {
                var data = new Dictionary<string, object?>
                {
                    ["engine"] = db.Database.ProviderName?.Contains("Npgsql") == true ? "postgres" : "unknown", ["op"] = row.Operation, ["table"] = row.Table,
                    ["pk"] = PrimaryKey(row.Entry), ["requestId"] = capture.RequestId,
                    ["durationMs"] = Stopwatch.GetElapsedTime(saved.Started).TotalMilliseconds,
                    ["callsite"] = row.Callsite, ["transactionOutcome"] = "committed"
                };
                if (row.Before is not null) data["before"] = row.Before;
                if (row.Operation != "delete") data["after"] = Row(row.Entry, false);
                if (tx is { } id)
                {
                    data["transactionId"] = id.ToString();
                    if (transactions.Values.Sum(v => v.Count) >= 200)
                    { capture.Add("capture_gap", new { kind = "capture_gap", surface = "db_diff", reason = "scan_budget_exceeded", requestId = capture.RequestId, detail = "Transaction row snapshot limit reached" }); break; }
                    if (!transactions.TryGetValue(id, out var list)) transactions[id] = list = [];
                    list.Add(data);
                }
                else capture.Add("db.diff", data);
            }
        }
        catch { capture.Add("capture_gap", new { surface = "db_diff", reason = "snapshot_failed", requestId = capture.RequestId }); log.LogWarning("Crumbtrail could not record saved database changes"); }
    }
    private void CompleteCore(Guid id, bool committed)
    {
        if (!transactions.Remove(id, out var rows)) return;
        if (committed) foreach (var row in rows) capture.Add("db.diff", row);
    }
    public static Dictionary<string,object?> Row(EntityEntry entry, bool original)
    {
        var table = StoreObjectIdentifier.Table(entry.Metadata.GetTableName()!, entry.Metadata.GetSchema());
        return entry.Properties.Take(64).ToDictionary(p => p.Metadata.GetColumnName(table) ?? p.Metadata.Name,
            p => CapturePrivacy.Value(p.Metadata.GetColumnName(table) ?? p.Metadata.Name, original ? p.OriginalValue : p.CurrentValue));
    }
    private static object? PrimaryKey(EntityEntry entry) => entry.Metadata.FindPrimaryKey()?.Properties.ToDictionary(
        p => p.GetColumnName(StoreObjectIdentifier.Table(entry.Metadata.GetTableName()!,entry.Metadata.GetSchema())) ?? p.Name,
        p => CapturePrivacy.PrimaryKey(p.GetColumnName(StoreObjectIdentifier.Table(entry.Metadata.GetTableName()!,entry.Metadata.GetSchema())) ?? p.Name,entry.Property(p.Name).CurrentValue));
}

public sealed class CaptureSaveChanges(CapturedChanges changes) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(DbContextEventData data, InterceptionResult<int> result)
    { changes.Before(data.Context); return result; }
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData data, InterceptionResult<int> result, CancellationToken ct = default)
    { changes.Before(data.Context); return ValueTask.FromResult(result); }
    public override int SavedChanges(SaveChangesCompletedEventData data, int result)
    { changes.After(data.Context); return result; }
    public override ValueTask<int> SavedChangesAsync(SaveChangesCompletedEventData data, int result, CancellationToken ct = default)
    { changes.After(data.Context); return ValueTask.FromResult(result); }
    public override void SaveChangesCanceled(DbContextEventData data) => changes.Failed(data.Context);
    public override Task SaveChangesCanceledAsync(DbContextEventData data, CancellationToken ct = default) { changes.Failed(data.Context); return Task.CompletedTask; }
    public override void SaveChangesFailed(DbContextErrorEventData data) => changes.Failed(data.Context);
    public override Task SaveChangesFailedAsync(DbContextErrorEventData data, CancellationToken ct = default)
    { changes.Failed(data.Context); return Task.CompletedTask; }
}

public sealed class CaptureTransactions(CapturedChanges changes) : DbTransactionInterceptor
{
    // EF does not expose the savepoint name here, so discard uncommitted images
    // rather than claim rows survived a partial transaction rollback.
    public override void RolledBackToSavepoint(DbTransaction transaction, TransactionEventData data) => changes.SavepointRollback(data.TransactionId);
    public override Task RolledBackToSavepointAsync(DbTransaction transaction, TransactionEventData data, CancellationToken ct = default)
    { changes.SavepointRollback(data.TransactionId); return Task.CompletedTask; }
    public override void TransactionCommitted(DbTransaction transaction, TransactionEndEventData data) => changes.Complete(data.TransactionId,true);
    public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData data, CancellationToken ct = default)
    { changes.Complete(data.TransactionId,true); return Task.CompletedTask; }
    public override void TransactionRolledBack(DbTransaction transaction, TransactionEndEventData data) => changes.Complete(data.TransactionId,false);
    public override Task TransactionRolledBackAsync(DbTransaction transaction, TransactionEndEventData data, CancellationToken ct = default)
    { changes.Complete(data.TransactionId,false); return Task.CompletedTask; }
}
