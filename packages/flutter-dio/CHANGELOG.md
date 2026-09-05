# Changelog

## 0.1.0

- Register one interceptor on a Dio instance to record status, method, redacted
  URL, error type and duration.
- Report the duration as covering the buffered body, which is what a Dio
  response interceptor can observe.
- Skip requests to the Crumbtrail ingest host, so an application that shares its
  Dio instance with the SDK's transport cannot feed capture into itself.
