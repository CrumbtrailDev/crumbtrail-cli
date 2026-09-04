using Crumbtrail;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
namespace Crumbtrail.Tests;
public sealed class EntityFrameworkTests
{
    private sealed class Sink : ICaptureSink { public void Enqueue(CaptureBatch batch) { } }
    public sealed class Probe { public int Id {get;set;} public decimal Amount {get;set;} public string Password {get;set;}=""; }
    private sealed class ProbeDb(DbContextOptions<ProbeDb> options):DbContext(options)
    {
        public DbSet<Probe> Probes=>Set<Probe>();
    }
    [Fact]
    public async Task Real_save_changes_capture_generated_key_originals_and_commit_but_not_rollback()
    {
        await using var connection=new SqliteConnection("Data Source=:memory:");await connection.OpenAsync();
        var capture=new CaptureContext();capture.Start("ses_test","req_test");
        var changes=new CapturedChanges(capture,NullLogger<CapturedChanges>.Instance);
        var options=new DbContextOptionsBuilder<ProbeDb>().UseSqlite(connection)
            .AddInterceptors(new CaptureSaveChanges(changes),new CaptureTransactions(changes)).Options;
        await using var db=new ProbeDb(options);await db.Database.EnsureCreatedAsync();
        var probe=new Probe{Amount=10,Password="row-secret"};db.Add(probe);await db.SaveChangesAsync();
        var insert=Assert.Single(capture.Events);Assert.Equal("db.diff",insert.k);
        using(var json=JsonDocument.Parse(JsonSerializer.Serialize(insert.d)))
        {Assert.True(json.RootElement.GetProperty("pk").GetProperty("Id").GetInt32()>0);Assert.Equal("insert",json.RootElement.GetProperty("op").GetString());}
        Assert.DoesNotContain("row-secret",JsonSerializer.Serialize(capture.Events));capture.Flush(new Sink());
        await using(var tx=await db.Database.BeginTransactionAsync())
        {probe.Amount=20;await db.SaveChangesAsync();Assert.Empty(capture.Events);await tx.CommitAsync();}
        using(var json=JsonDocument.Parse(JsonSerializer.Serialize(Assert.Single(capture.Events).d)))
        {Assert.Equal(10,json.RootElement.GetProperty("before").GetProperty("Amount").GetDecimal());Assert.Equal(20,json.RootElement.GetProperty("after").GetProperty("Amount").GetDecimal());}
        capture.Flush(new Sink());
        await using(var tx=await db.Database.BeginTransactionAsync())
        {probe.Amount=30;await db.SaveChangesAsync();await tx.RollbackAsync();}
        Assert.Empty(capture.Events);await db.Entry(probe).ReloadAsync();Assert.Equal(20,probe.Amount);
        db.Remove(probe);await db.SaveChangesAsync();
        using(var json=JsonDocument.Parse(JsonSerializer.Serialize(Assert.Single(capture.Events).d)))
        {Assert.Equal("delete",json.RootElement.GetProperty("op").GetString());Assert.Equal(20,json.RootElement.GetProperty("before").GetProperty("Amount").GetDecimal());Assert.False(json.RootElement.TryGetProperty("after",out _));}
    }
    [Theory]
    [InlineData("select 'secret', E'also\\\'secret', $$secret$$, $tag$secret$tag$, 123, @password -- secret\n from things", "secret")]
    [InlineData("select /* secret /* nested */ still secret */ \"things\" where id=$1", "secret")]
    [InlineData("select 'unterminated-secret", "secret")]
    [InlineData("select U&'secret'", "secret")]
    public void Sql_shapes_never_include_values_or_comments(string sql, string value)
    { Assert.DoesNotContain(value,CaptureCommands.Shape(sql)); Assert.DoesNotContain("password",CaptureCommands.Shape(sql)); }

    [Fact]
    public void Sql_shapes_remove_boolean_and_nondecimal_literals()
    { Assert.Equal("SELECT ?, ?, ?, ?, ?, ?",CaptureCommands.Shape("SELECT true, false, null, 0xABDEAD, 0b101, 0o777")); }

    private sealed class Row { public int Id {get;set;} public int Amount {get;set;} }
    private sealed class Db(DbContextOptions<Db> options) : DbContext(options) { public DbSet<Row> Rows => Set<Row>(); }
    [Fact]
    public async Task Commands_observe_reads_bulk_updates_and_failures_without_row_claims()
    {
        await using var conn = new SqliteConnection("Data Source=:memory:"); await conn.OpenAsync();
        var capture = new CaptureContext();
        await using var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).AddInterceptors(new CaptureCommands(capture)).Options);
        await db.Database.EnsureCreatedAsync(); db.Add(new Row {Amount=1}); await db.SaveChangesAsync(); Assert.Empty(capture.Events);
        capture.Start("ses_sql","req_sql");
        Assert.Single(await db.Rows.Where(r=>r.Amount==1).ToListAsync());
        Assert.Equal(1,await db.Rows.ExecuteUpdateAsync(s=>s.SetProperty(r=>r.Amount,2)));
        await Assert.ThrowsAsync<SqliteException>(()=>db.Database.ExecuteSqlRawAsync("UPDATE missing_table SET amount = 'private-literal'"));
        Assert.Contains(capture.Events,e=>e.k=="db.statement" && JsonSerializer.Serialize(e.d).Contains("select"));
        var update=capture.Events.Where(e=>e.k=="db.statement").Select(e=>JsonSerializer.Serialize(e.d)).Single(s=>s.Contains("\"op\":\"update\""));
        Assert.Contains("\"rowCount\":1",update); Assert.Contains("not_captured",update);
        Assert.Contains(capture.Events,e=>e.k=="db.error"); Assert.DoesNotContain(capture.Events,e=>e.k=="db.diff");
        Assert.DoesNotContain("private-literal",JsonSerializer.Serialize(capture.Events));
    }

    [Fact]
    public async Task Savepoint_rollback_omits_uncertain_rows_and_allows_later_committed_saves()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        using var changes = new CapturedChanges(capture, NullLogger<CapturedChanges>.Instance);
        await using var db = new ProbeDb(new DbContextOptionsBuilder<ProbeDb>().UseSqlite(connection)
            .AddInterceptors(new CaptureSaveChanges(changes), new CaptureTransactions(changes)).Options);
        await db.Database.EnsureCreatedAsync();
        await using var tx = await db.Database.BeginTransactionAsync();
        await tx.CreateSavepointAsync("before_rows");
        db.Add(new Probe { Amount = 10 }); await db.SaveChangesAsync();
        await tx.RollbackToSavepointAsync("before_rows");
        db.ChangeTracker.Clear();
        db.Add(new Probe { Amount = 20 }); await db.SaveChangesAsync(); await tx.CommitAsync();
        Assert.Contains(capture.Events, e => e.k == "capture_gap");
        var row = Assert.Single(capture.Events, e => e.k == "db.diff");
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(row.d));
        Assert.Equal(20, document.RootElement.GetProperty("after").GetProperty("Amount").GetDecimal());
        Assert.Single(await db.Probes.ToArrayAsync());
    }

    [Fact]
    public async Task Cancelled_save_does_not_leave_phantom_rows_for_next_save()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        using var changes = new CapturedChanges(capture, NullLogger<CapturedChanges>.Instance);
        await using var db = new ProbeDb(new DbContextOptionsBuilder<ProbeDb>().UseSqlite(connection)
            .AddInterceptors(new CaptureSaveChanges(changes)).Options);
        await db.Database.EnsureCreatedAsync();
        db.Add(new Probe { Amount = 10 });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => db.SaveChangesAsync(new CancellationToken(true)));
        Assert.Empty(capture.Events); db.ChangeTracker.Clear();
        db.Add(new Probe { Amount = 20 }); await db.SaveChangesAsync();
        Assert.Single(capture.Events, e => e.k == "db.diff");
    }

    private sealed class SensitiveKey
    {
        [System.ComponentModel.DataAnnotations.Schema.Column("account_number")]
        public int Id { get; set; }
    }
    private sealed class SensitiveDb(DbContextOptions<SensitiveDb> options) : DbContext(options)
    { public DbSet<SensitiveKey> Rows => Set<SensitiveKey>(); }
    [Fact]
    public async Task Primary_keys_use_mapped_column_privacy_names()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        using var changes = new CapturedChanges(capture, NullLogger<CapturedChanges>.Instance);
        await using var db = new SensitiveDb(new DbContextOptionsBuilder<SensitiveDb>().UseSqlite(connection)
            .AddInterceptors(new CaptureSaveChanges(changes)).Options);
        await db.Database.EnsureCreatedAsync(); db.Add(new SensitiveKey { Id = 8675309 }); await db.SaveChangesAsync();
        var data = JsonSerializer.SerializeToElement(Assert.Single(capture.Events).d);
        Assert.Equal("[REDACTED]", data.GetProperty("pk").GetProperty("account_number").GetString());
        Assert.DoesNotContain("8675309", JsonSerializer.Serialize(capture.Events));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Disabled_auto_detection_preserves_application_save_semantics(bool instrumented)
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        using var changes = new CapturedChanges(capture, NullLogger<CapturedChanges>.Instance);
        var options = new DbContextOptionsBuilder<ProbeDb>().UseSqlite(connection);
        if (instrumented) options.AddInterceptors(new CaptureSaveChanges(changes));
        await using var db = new ProbeDb(options.Options); await db.Database.EnsureCreatedAsync();
        var row = new Probe { Amount = 10 }; db.Add(row); await db.SaveChangesAsync(); capture.Flush(new Sink());
        db.ChangeTracker.AutoDetectChangesEnabled = false;
        row.Amount = 20;
        Assert.Equal(0, await db.SaveChangesAsync());
        Assert.Empty(capture.Events);
        Assert.Equal(10, (await db.Probes.AsNoTracking().SingleAsync()).Amount);
        db.Entry(row).Property(p => p.Amount).IsModified = true;
        Assert.Equal(1, await db.SaveChangesAsync());
        Assert.Equal(20, (await db.Probes.AsNoTracking().SingleAsync()).Amount);
        Assert.Equal(instrumented ? 1 : 0, capture.Events.Count);
    }

    private sealed class GuidKey { public Guid Id { get; set; } }
    private sealed class GuidDb(DbContextOptions<GuidDb> options) : DbContext(options)
    { public DbSet<GuidKey> Rows => Set<GuidKey>(); }
    [Fact]
    public async Task Typed_guid_primary_keys_preserve_row_identity()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:"); await connection.OpenAsync();
        var capture = new CaptureContext(); capture.Start("ses_test", "req_test");
        using var changes = new CapturedChanges(capture, NullLogger<CapturedChanges>.Instance);
        await using var db = new GuidDb(new DbContextOptionsBuilder<GuidDb>().UseSqlite(connection)
            .AddInterceptors(new CaptureSaveChanges(changes)).Options);
        await db.Database.EnsureCreatedAsync(); var id = Guid.NewGuid(); db.Add(new GuidKey { Id = id }); await db.SaveChangesAsync();
        var data = JsonSerializer.SerializeToElement(Assert.Single(capture.Events).d);
        Assert.Equal(id.ToString(), data.GetProperty("pk").GetProperty("Id").GetString());
        Assert.Equal("[REDACTED]", data.GetProperty("after").GetProperty("Id").GetString());
    }
}
