# Datadog -> Crumbtrail

Keep the Datadog exporter and add Crumbtrail as a second OTLP/HTTP exporter.

```yaml
exporters:
  datadog:
    api:
      key: ${env:DD_API_KEY}
  otlphttp/crumbtrail:
    endpoint: http://127.0.0.1:9898
    compression: none

service:
  pipelines:
    traces:
      exporters: [datadog, otlphttp/crumbtrail]
    logs:
      exporters: [datadog, otlphttp/crumbtrail]
```

## Verify

Start Crumbtrail locally, send one payload, then run:

```bash
crumbtrail-server doctor --port 9898
```

Doctor should report the first OTLP payload, including received span count, service name, and created session id.

## Notes

- Use otlphttp/crumbtrail, not otlp/crumbtrail, for Crumbtrail's HTTP listener.
- For dd-trace deployments that already emit OTLP, add Crumbtrail as an additional OTLP/HTTP destination.
- Crumbtrail's exporter sets compression: none (the collector's OTLP/HTTP default is gzip). Crumbtrail accepts gzip too, but none keeps this recipe honest with the receiver's recommended posture.
- Reference the Datadog API key via the ${env:DD_API_KEY} expansion so the collector reads it from the environment.

- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.
- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.
