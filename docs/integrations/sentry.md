# Sentry via OpenTelemetry -> Crumbtrail

Fan out OpenTelemetry-backed Sentry traces to Crumbtrail.

```yaml
exporters:
  otlphttp/sentry:
    endpoint: ${SENTRY_OTLP_ENDPOINT}
  otlphttp/crumbtrail:
    endpoint: http://127.0.0.1:9898
    compression: none

service:
  pipelines:
    traces:
      exporters: [otlphttp/sentry, otlphttp/crumbtrail]
```

## Verify

Start Crumbtrail locally, send one payload, then run:

```bash
crumbtrail-server doctor --port 9898
```

Doctor should report the first OTLP payload, including received span count, service name, and created session id.

## Notes

- Keep Sentry as the system of record for issues; Crumbtrail consumes the same traces as agent-readable evidence.
- Sentry-side exporter auth is deployment-specific — configure the otlphttp/sentry exporter's authentication per your Sentry setup (self-hosted vs. SaaS differ). This recipe does not prescribe a header.
- Crumbtrail's exporter sets compression: none to match the receiver's recommended posture (gzip is also accepted).
- Backfill import is Wave 2; this recipe is for live OTLP fanout.

- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.
- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.
