# Honeycomb → Crumbtrail

Honeycomb is OTLP-native, so the same OTel pipeline feeds both. In a Collector, add:

    exporters:
      otlp/honeycomb:
        endpoint: api.honeycomb.io:443
        headers: { "x-honeycomb-team": "${HONEYCOMB_API_KEY}" }
      otlphttp/crumbtrail:
        endpoint: http://127.0.0.1:9898

    service:
      pipelines:
        traces:
          exporters: [otlp/honeycomb, otlphttp/crumbtrail]

Set `crumbtrail.session.id` as a resource attribute to correlate to a frontend session.
