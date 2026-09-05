# Capture ASP.NET Core request evidence

Requires .NET 9. This package owns JSON redaction, request buffering, response capture,
correlation and bounded delivery. Application code selects eligible routes.

```sh
dotnet add package Crumbtrail.AspNetCore --version 0.1.0
```

Version 0.1.0 is pending publication. Before release, build a local package with
`dotnet pack packages/dotnet/Crumbtrail.AspNetCore -o /tmp/crumbtrail-nuget`
and add `--source /tmp/crumbtrail-nuget` to the installation command.

```csharp
using Crumbtrail;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCrumbtrail(CaptureOptions.FromEnvironment("orders-api") with
{
    ShouldCapture = context => context.Request.Path.StartsWithSegments("/api/orders")
});
var app = builder.Build();
app.UseRouting();
app.UseCrumbtrail();
app.MapPost("/api/orders", () => new { amount = 18.75, unit = "CAD" });
app.Run();
```

Set `CRUMBTRAIL_ENDPOINT` to the HTTPS capture origin and `CRUMBTRAIL_INGEST_KEY`
to the project ingest key. `CRUMBTRAIL_SERVICE` overrides the service name.
Missing or invalid configuration disables capture. No routes are captured by default.
Select only routes suitable for capture and exclude authentication routes.
Requests without valid browser session and request correlation headers are skipped.

The package sends native events to `/api/events` outside application requests. It
queues at most 64 batches and attempts delivery four times with a five second HTTP
timeout. Full queues and exhausted retries drop evidence and log the reason.
Process shutdown can lose queued evidence. Redirects are disabled.

JSON bodies are capped at 16,384 bytes. Oversized bodies are omitted, never retained
as partial JSON. The conservative profile retains bounded numbers, booleans, null,
short lowercase enums, three uppercase letter units and short digit identifiers.
Other strings and sensitive fields are withheld. Duplicate keys and unsupported
structure produce explicit invalid states. Cloud validation remains mandatory.
This profile does not promise parity with the Node SDK's richer redaction shapes.

Verify a correlated JSON request in Sessions. Confirm both `backend.req.start` and
`backend.req.end`, retained safe values and explicit body states. Repeat with a
secret field and an oversized response. Application request and response bytes
must remain unchanged. A browser session must exist before native events can be
accepted. Delivery retries cover a brief session registration race.

Update the package reference to update capture behavior. Do not copy its source
into the application. Database, cache and job instrumentation are separate from
this HTTP integration.

## Verify and pack a release

From the repository root with the .NET 9 SDK on PATH:

```sh
pnpm test:dotnet
pnpm pack:dotnet
```

The package is written to `.local-packs/dotnet`. Install that artifact into a
fresh consumer using the CLI's `--source` option and build the consumer before
publishing. Publish version `0.1.0` to NuGet before merging an application change
that references it. The npm release workflow does not publish NuGet packages.

## Capture EF Core commands and saved changes

Install `Crumbtrail.EntityFrameworkCore` 0.1.0 alongside `Crumbtrail.AspNetCore`
0.1.0. Both packages must be published before a normal NuGet restore can use
this integration. Requires .NET 9 and EF Core 9. PostgreSQL is the target
provider. The regression suite also exercises interception using SQLite.

Register the maintained interceptors in each application's existing DbContext
configuration. Keep the provider and connection string configuration already
used by that application:

```csharp
using Crumbtrail;
using Microsoft.EntityFrameworkCore;

builder.Services.AddCrumbtrailEntityFramework();
builder.Services.AddDbContext<AppDbContext>((services, options) =>
    options.UseNpgsql(connectionString).AddCrumbtrail(services));
```

The adapter resolves the same scoped `CaptureContext` as HTTP capture, and
registers one itself when an application uses EF capture without it. It emits
query shape, duration, affected row count when available, and SQLSTATE error
category. SQL parameter values and database error messages are withheld. SQL
containing backslashes is omitted because PostgreSQL session settings change
how string escapes are interpreted.

Tracked `SaveChanges` operations emit redacted before and after images only
after a successful save or an observed explicit transaction commit. Bulk SQL
and `ExecuteUpdate` provide command evidence without row images. Explicit
rollback discards pending images. A transaction disposed without a commit
releases its images. Savepoint rollback discards uncertain images
and emits a capture gap. Ambient `TransactionScope` and explicitly enlisted transaction row images are unsupported
and emit a capture gap. Transactions committed outside EF interception cannot
produce confirmed row images. Scoped disposal releases pending snapshots.

The adapter caps snapshots at 100 rows per save, 64 properties per row and
200 pending transaction images per scope. Database values use the same
conservative structured profile as HTTP bodies. Free text and UUID strings are redacted. Typed `Guid` primary keys from EF
metadata retain row identity when their mapped column name is not sensitive.
Sensitive keys remain redacted and cannot establish row identity. Capture failures do not change database results.

## Observe cache operations

`AddCrumbtrail` registers scoped `CaptureCache`. Inject it where the application
calls its cache client, then wrap the existing operation:

```csharp
var value = await captureCache.Observe("get", cacheKey,
    () => redis.StringGetAsync(cacheKey), value => value.HasValue);
```

This wrapper owns timing, success or failure, hit status and capture events.
It returns the original value and rethrows the original exception. It never
records cache values, raw keys or exception messages. Keys use HMAC with a
random process key, so repeated keys can correlate within that process but
not across processes or restarts. Operation names are limited to `get`, `set`,
`delete`, `exists`, `expire` and `increment`. Other names become `other`.
Optional `ttlMs` accepts finite nonnegative milliseconds. No cache client is
patched automatically. The recorded `driver` reads `unknown` unless the
application names its cache: `new CaptureCache(capture, "redis")`.

## Observe background jobs

Run each job in a fresh DI scope with its scoped capture context. Keep tenant
authorization and the decision to carry a parent's correlation in application
code. Use a static lowercase job name and a UUID job identifier:

```csharp
var result = await CaptureJob.RunAsync(capture, sink, options,
    new CaptureParent(parentSessionId, parentRequestId),
    jobId.ToString(), "calculation", () => RunCalculationAsync(cancellationToken));
```

The wrapper creates a unique request ID, preserves `parentRequestId`, records
start, error and end events, flushes and clears the context. It preserves the
work result, cancellation and exception. Invalid parent identifiers or a
context already in use run the work without starting another job capture.
Pass `null` for work without an authorized parent session. Flush queues
best effort delivery through the configured sink, not a durable acknowledgement.

Verify an HTTP request and a correlated job using a capture sink. Confirm
`db.statement`, committed `db.diff`, `cache` and `backend.job.*` events and
absence of secrets. Run the local suites with:

```sh
dotnet test packages/dotnet/Crumbtrail.AspNetCore.Tests
dotnet test packages/dotnet/Crumbtrail.EntityFrameworkCore.Tests
```

For live adapter verification, point `CRUMBTRAIL_DOTNET_POSTGRES` at an isolated
local PostgreSQL admin connection and `CRUMBTRAIL_DOTNET_REDIS` at an isolated
local Redis endpoint before running those suites. The PostgreSQL test creates
and drops a uniquely named `crumbtrail_adapter_*` database. The Redis test
creates and deletes a uniquely named key with a one minute expiration. Without
these variables, the respective live tests are explicitly skipped.

Optional source locations can use `CaptureCallsite.Create("/MyApi/", "src/MyApi/")`
as the scoped context's `Callsite` callback. The marker identifies the application
source directory in debug symbols. The prefix maps it to a repository relative
path. Missing source symbols produce no callsite. This mapping keeps absolute
local build paths out of captured locations.
