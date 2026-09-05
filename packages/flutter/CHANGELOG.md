# Changelog

## Next

- Add optional Android and iOS native diagnostics through a platform channel.
- Capture foreground Dart event loop stalls with bounded previous launch handoff.
- Redact credential shaped URL path segments and query values, not only query
  key names, and emit the `[REDACTED]` marker literally instead of percent
  encoding it.
- Preserve the raw query structure, so repeated keys and encoded characters
  survive redaction unchanged.
- Add `capturesRequestTo`, which excludes the configured ingest host so an
  adapter cannot record Crumbtrail's own delivery.
- Add an optional `durTo` to `recordRequest`, naming which phase `dur` covers.
- Move the HTTP adapters into `crumbtrail_flutter_http` and
  `crumbtrail_flutter_dio`, so this package still has one runtime dependency.

## 0.1.0

- Capture Flutter framework and unhandled asynchronous errors.
- Record navigation, application lifecycle, environment, and explicit requests.
- Preserve sessions across launches and retry batches after network failures.
- Redact credential shaped headers, query values, URL user information, and fragments before delivery.
