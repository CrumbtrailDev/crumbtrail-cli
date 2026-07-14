# OpenTelemetry SDK -> Crumbtrail

Point any OTLP-capable SDK at Crumbtrail's OTLP/HTTP receiver.

```yaml
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9898
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

## Verify

Start Crumbtrail locally, send one payload, then run:

```bash
crumbtrail-server doctor --port 9898
```

Doctor should report the first OTLP payload, including received span count, service name, and created session id.

## Notes

- Use the Crumbtrail server base URL as the OTLP endpoint; SDK exporters append /v1/traces and /v1/logs.
- Sessionless spans and logs are accepted and grouped into auto sessions. Add crumbtrail.session.id later when you want explicit frontend session joins.

- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.
- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.
