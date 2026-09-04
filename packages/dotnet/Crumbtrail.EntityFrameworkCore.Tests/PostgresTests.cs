using System.Transactions;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;
namespace Crumbtrail.Tests;

public sealed class PostgresFactAttribute : FactAttribute
{
    public PostgresFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CRUMBTRAIL_DOTNET_POSTGRES")))
            Skip = "Set CRUMBTRAIL_DOTNET_POSTGRES to a throwaway local PostgreSQL admin connection.";
    }
}
public sealed class PostgresTests
{
    public sealed class Row { public int Id { get; set; } public decimal Amount { get; set; } public string Password { get; set; } = ""; }
    public sealed class GuidRow { public Guid Id { get; set; } }
    private sealed class Db(DbContextOptions<Db> options) : DbContext(options)
    {
        public DbSet<Row> Rows => Set<Row>();
        public DbSet<GuidRow> GuidRows => Set<GuidRow>();
    }
    private sealed class Sink : ICaptureSink { public List<CaptureEvent> Events = []; public void Enqueue(CaptureBatch batch) => Events.AddRange(batch.events); }

    [PostgresFact]
    public async Task PostgreSQL_confirms_commit_rollback_savepoint_sqlstate_and_redaction()
    {
        var adminString = Environment.GetEnvironmentVariable("CRUMBTRAIL_DOTNET_POSTGRES")!;
        var database = "crumbtrail_adapter_" + Guid.NewGuid().ToString("N");
        await using var admin = new NpgsqlConnection(adminString); await admin.OpenAsync();
        await using (var create = new NpgsqlCommand($"CREATE DATABASE {database}", admin)) await create.ExecuteNonQueryAsync();
        var target = new NpgsqlConnectionStringBuilder(adminString) { Database = database, Pooling = false }.ConnectionString;
        try
        {
            var services = new ServiceCollection(); services.AddLogging(); services.AddScoped<CaptureContext>();
            services.AddCrumbtrailEntityFramework();
            services.AddDbContext<Db>((sp, options) => options.UseNpgsql(target).AddCrumbtrail(sp));
            using var provider = services.BuildServiceProvider(); using var scope = provider.CreateScope();
            var capture = scope.ServiceProvider.GetRequiredService<CaptureContext>();
            var db = scope.ServiceProvider.GetRequiredService<Db>();
            await db.Database.EnsureCreatedAsync(); capture.Start("ses_postgres", "req_postgres");
            var row = new Row { Amount = 10, Password = "private-row-secret" }; db.Add(row); await db.SaveChangesAsync();
            await using (var tx = await db.Database.BeginTransactionAsync())
            { row.Amount = 20; await db.SaveChangesAsync(); await tx.CommitAsync(); }
            await using (var tx = await db.Database.BeginTransactionAsync())
            { row.Amount = 30; await db.SaveChangesAsync(); await tx.RollbackAsync(); }
            await db.Entry(row).ReloadAsync(); Assert.Equal(20, row.Amount);
            await using (var tx = await db.Database.BeginTransactionAsync())
            {
                await tx.CreateSavepointAsync("safe_point"); row.Amount = 40; await db.SaveChangesAsync();
                await tx.RollbackToSavepointAsync("safe_point"); await db.Entry(row).ReloadAsync();
                row.Amount = 50; await db.SaveChangesAsync(); await tx.CommitAsync();
            }
            await Assert.ThrowsAsync<PostgresException>(() => db.Database.ExecuteSqlRawAsync("INSERT INTO \"Rows\" (\"Id\", \"Amount\", \"Password\") VALUES (1, 99, 'private-sql-secret')"));
            Assert.Equal(50, (await db.Rows.AsNoTracking().SingleAsync()).Amount);
            var images = capture.Events.Where(e => e.k == "db.diff").Select(e => JsonSerializer.SerializeToElement(e.d)).ToArray();
            Assert.Equal(new decimal[] { 10, 20, 50 }, images.Select(e => e.GetProperty("after").GetProperty("Amount").GetDecimal()));
            Assert.All(images, e => Assert.Equal("postgres", e.GetProperty("engine").GetString()));
            var error = JsonSerializer.SerializeToElement(Assert.Single(capture.Events, e => e.k == "db.error").d);
            Assert.Equal("23505", error.GetProperty("code").GetString()); Assert.Equal("constraint", error.GetProperty("category").GetString());
            Assert.Contains(capture.Events, e => e.k == "capture_gap");
            var beforeEnlisted = capture.Events.Count(e => e.k == "db.diff");
            using (var external = new System.Transactions.CommittableTransaction())
            {
                await db.Database.OpenConnectionAsync();
                db.Database.EnlistTransaction(external);
                Assert.Null(System.Transactions.Transaction.Current);
                row.Amount = 60; await db.SaveChangesAsync();
                Assert.Equal(beforeEnlisted, capture.Events.Count(e => e.k == "db.diff"));
                external.Rollback();
                db.Database.EnlistTransaction(null);
                await db.Database.CloseConnectionAsync();
            }
            Assert.Equal(50, (await db.Rows.AsNoTracking().SingleAsync()).Amount);
            Assert.Contains(capture.Events, e => e.k == "capture_gap" && JsonSerializer.Serialize(e.d).Contains("unsupported_transaction"));
            var guid = Guid.Parse("be3ac089-71fe-4dda-ae99-6403ec2dba82");
            db.Add(new GuidRow { Id = guid }); await db.SaveChangesAsync();
            var guidEvent = JsonSerializer.SerializeToElement(capture.Events.Last(e => e.k == "db.diff").d);
            Assert.Equal(guid.ToString(), guidEvent.GetProperty("pk").GetProperty("Id").GetString());
            var wire = JsonSerializer.Serialize(capture.Events); Assert.DoesNotContain("private-row-secret", wire); Assert.DoesNotContain("private-sql-secret", wire);
            if (Environment.GetEnvironmentVariable("CRUMBTRAIL_DOTNET_POSTGRES_EXPORT") is { Length: > 0 } path)
            {
                var sink = new Sink(); capture.Flush(sink);
                await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new { sessionId = "ses_postgres", events = sink.Events }));
            }
        }
        finally { await using var drop = new NpgsqlCommand($"DROP DATABASE {database} WITH (FORCE)", admin); await drop.ExecuteNonQueryAsync(); }
    }
}
