# OpenTelemetry Collector -> Crumbtrail

Use this recipe when your app already exports traces to an OpenTelemetry
Collector and you want to fan out those traces to Crumbtrail.

Crumbtrail accepts OTLP/HTTP trace payloads at `/v1/traces` and log payloads at
`/v1/logs` when they are sent as OTLP protobuf or OTLP JSON. Prefer the
Collector's default protobuf encoding unless you need JSON for debugging.

```yaml
exporters:
  otlphttp/crumbtrail:
    endpoint: http://127.0.0.1:9898
    compression: none

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/crumbtrail] # plus your existing exporters
    # Optional: add logs when you also want OTLP logs in Crumbtrail.
    logs:
      receivers: [otlp]
      exporters: [otlphttp/crumbtrail]
```

The `endpoint` is the Crumbtrail server base URL. The Collector appends
`/v1/traces` for the trace pipeline and `/v1/logs` for the logs pipeline, so do
not include those paths in the base `endpoint` unless you use pipeline-specific
endpoint settings instead.

## Auth

Local loopback ingest works without auth when `crumbtrail-server serve` is listening on
`127.0.0.1` and the Collector sends to that same host.

If you start Crumbtrail with `--auth-token` or `CRUMBTRAIL_AUTH_TOKEN`, every
Collector request must include that token as `X-Crumbtrail-Auth`:

```yaml
exporters:
  otlphttp/crumbtrail:
    endpoint: http://127.0.0.1:9898
    compression: none
    headers:
      X-Crumbtrail-Auth: ${CRUMBTRAIL_AUTH_TOKEN}
```

## Remote Server Requirements

The local server rejects non-loopback OTLP writes by default. Remote Collector
traffic requires a Crumbtrail server runtime configured with remote API writes
enabled and an auth token. Remote API mode is intentionally unavailable without
an auth token.

For the CLI path documented in the quickstart, keep the Collector and
`crumbtrail-server serve` on the same machine and send to `http://127.0.0.1:9898`.

## Correlation

Crumbtrail files OTLP spans into sessions by reading the
`crumbtrail.session.id` attribute. Set it as a resource attribute when all spans
in the resource belong to the same Crumbtrail session, or as a span attribute
when the session varies per span.

```yaml
processors:
  resource/crumbtrail:
    attributes:
      - key: crumbtrail.session.id
        value: ${CRUMBTRAIL_SESSION_ID}
        action: upsert

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource/crumbtrail]
      exporters: [otlphttp/crumbtrail]
```

Spans without a valid `crumbtrail.session.id` are accepted by the endpoint but
reported as skipped and are not written to a session. Invalid or unsafe session
ids are also skipped.

For frontend-to-backend correlation, propagate W3C `traceparent` from the
browser into backend requests. Crumbtrail stores the OTLP `traceId` as the
backend span `requestId`, which lets the fix bundle connect a frontend click to
backend trace evidence by the shared trace id.

## Current Limits

- Request body must be protobuf with `Content-Type: application/x-protobuf` or
  another protobuf content type, or JSON with `Content-Type: application/json`
  or another JSON content type.
- Request body limit is 1 MiB by default.
- Converted OTLP events are limited to 1,000 events per request by default.
- Each session event log is capped at 50 MiB by default. When a session reaches
  that cap, Crumbtrail writes `capture-truncated.json`, accepts only the events
  that fit, and reports dropped events as skipped.
- This recipe is trace-first and can also fan out OTLP logs. Metrics ingest is
  not part of this path.

The Collector OTLP HTTP exporter documents encoding and the base endpoint
behavior in the upstream OpenTelemetry Collector README:
https://github.com/open-telemetry/opentelemetry-collector/blob/main/exporter/otlphttpexporter/README.md
