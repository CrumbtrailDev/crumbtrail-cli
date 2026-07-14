# Grafana Alloy -> Crumbtrail

Forward Alloy OTel pipelines to Crumbtrail.

```yaml
otelcol.exporter.otlphttp "crumbtrail" {
  client {
    endpoint    = "http://127.0.0.1:9898"
    compression = "none"
  }
}

otelcol.processor.batch "default" {
  output {
    traces = [otelcol.exporter.otlphttp.crumbtrail.input]
    logs   = [otelcol.exporter.otlphttp.crumbtrail.input]
  }
}
```

## Verify

Start Crumbtrail locally, send one payload, then run:

```bash
crumbtrail-server doctor --port 9898
```

Doctor should report the first OTLP payload, including received span count, service name, and created session id.

## Notes

- This is an OTLP/HTTP exporter; do not point Alloy's OTLP gRPC exporter at Crumbtrail's HTTP port.
- Keep your existing Grafana export path and add Crumbtrail as a second output.
- The client sets compression = "none" to match the receiver's recommended posture (gzip is also accepted).

- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.
- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.
