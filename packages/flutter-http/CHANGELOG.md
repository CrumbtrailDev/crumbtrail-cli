# Changelog

## 0.1.0

- Wrap a `package:http` client to record status, method, redacted URL and time
  to response headers.
- Skip requests to the Crumbtrail ingest host, so an application that shares its
  client with the SDK's transport cannot feed capture into itself.
