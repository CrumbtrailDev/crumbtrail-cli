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
