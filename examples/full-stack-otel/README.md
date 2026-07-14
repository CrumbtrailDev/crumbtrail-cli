# Full-stack OTLP correlation (Path C)

Proves that a team **already on an OpenTelemetry stack** gets automatic front-end ↔ back-end
correlation by pointing their exporter at Crumbtrail — no Crumbtrail SDK on the server, no
manual id stamping.

## The chain

1. **Browser SDK** (`crumbtrail-core`, `network: true`, `networkCorrelationHeaders: true`)
   auto-injects a spec-valid W3C `traceparent` (`00-<traceId>-<spanId>-01`) on every
   instrumented `fetch`/XHR, and uses that **trace id as the request id** it records on
   `net.req`/`net.res`.
2. **OTel-only backend** (`server.mjs`) has no Crumbtrail SDK. It continues the propagated
   trace and exports the resulting **error span over OTLP** to Crumbtrail's `/v1/traces`
   ingest. The span's `traceId` is the same one the browser minted.
3. **OTLP adapter** bridges `span.traceId → requestId`, so Crumbtrail's full-stack linker
   joins the front-end interaction to the back-end error on a single shared key.
4. **MCP** `getLinkedRequestContext` returns the linked moment — front-end 500, back-end
   OTLP error span, correlated.

The session id rides along as the OTLP **resource attribute** `crumbtrail.session.id`, which
routes the span into the right session and enables the session-level join too.

## Run it

```bash
pnpm verify:full-stack-otel
```

This builds `crumbtrail-core` + `crumbtrail-node`, boots an in-process Crumbtrail server and the
OTel demo backend, performs one instrumented fetch, finalizes the session, and asserts:

- `net.req`/`net.res` and the ingested `backend.otel.span` share the trace id,
- `index.json` → `fullStackRequests.summary.linked >= 1` with front-end & back-end `500`,
- the back-end correlation provenance is `otlp-trace-id` (not a Crumbtrail header),
- the 32-hex trace id survives into `llm.md` (it is a correlation key, not a secret, so it is
  exempt from token redaction),
- MCP `getLinkedRequestContext` reports `status: "linked"`.

A bounded JSON summary is printed on success.

## Standalone backend

```bash
node examples/full-stack-otel/server.mjs --port 4000 --endpoint http://localhost:9898 --session-id <id>
# GET http://localhost:4000/api/demo-bug  → exports a correlated OTLP error span
```

> The OTLP payload is hand-built (no `@opentelemetry/*` dependency) so the example stays lean
> and runnable with just `node`; it is byte-for-byte what a real exporter would POST.

## Note on `traceparent` and cross-origin requests

`traceparent` is injected on the same requests as the `X-Crumbtrail-*` correlation headers.
`networkCorrelationHeaders` is **on by default**. Same-origin requests are stamped
automatically, while cross-origin requests are stamped only when their origin is listed in
`networkCorrelationAllowedOrigins`. That keeps third-party APIs from receiving trace context
or unexpected CORS preflights by default.
