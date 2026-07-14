# Splunk Observability Cloud -> Crumbtrail

Fan out Splunk OTel Collector telemetry to Crumbtrail.

```yaml
exporters:
  otlphttp/splunk:
    traces_endpoint: https://ingest.${SPLUNK_REALM}.signalfx.com/v2/trace/otlp
    headers:
      X-SF-Token: ${SPLUNK_ACCESS_TOKEN}
  otlphttp/crumbtrail:
    endpoint: http://127.0.0.1:9898
    compression: none

service:
  pipelines:
    traces:
      exporters: [otlphttp/splunk, otlphttp/crumbtrail]
    logs:
      exporters: [otlphttp/crumbtrail]
```

## Verify

Start Crumbtrail locally, send one payload, then run:

```bash
crumbtrail-server doctor --port 9898
```

Doctor should report the first OTLP payload, including received span count, service name, and created session id.

## Notes

- Splunk Observability Cloud ingests OTLP traces at the realm's /v2/trace/otlp endpoint (traces_endpoint); the Splunk exporter here mirrors traces only.
- Splunk Platform logs go through HEC, not this OTLP trace endpoint — sending Splunk logs is out of scope for this recipe, so the logs pipeline exports to Crumbtrail only.
- Crumbtrail still receives both traces (/v1/traces) and logs (/v1/logs), with compression: none to match the receiver's recommended posture (gzip is also accepted).

- Crumbtrail accepts sessionless OTLP and auto-creates sessions from service/version/environment attributes.
- Add `crumbtrail.session.id` later when you want strict frontend/backend session joins.
