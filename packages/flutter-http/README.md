# crumbtrail_flutter_http

`package:http` capture for [Crumbtrail](https://crumbtrail.ai). Wrap the client
your application already uses and every request through it becomes a `net`
event on the session.

Its own package on purpose. Dart has no compile-only dependency, so anything
`crumbtrail_flutter` declares is a package every consumer has to resolve.
Putting `http` in the SDK would mean an application pinned to a different major
version could not run `pub get` because of a capture adapter it never enabled.

## Install

```yaml
dependencies:
  crumbtrail_flutter: ^0.1.0
  crumbtrail_flutter_http: ^0.1.0
```

## Use

```dart
import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:crumbtrail_flutter_http/crumbtrail_flutter_http.dart';
import 'package:http/http.dart' as http;

final client = CrumbtrailClient(
  crumbtrail: Crumbtrail.instance!,
  inner: http.Client(),
);
final response = await client.get(Uri.parse('https://example.com/api/items'));
client.close(); // Also closes the wrapped client.
```

Start Crumbtrail before wrapping a client. Register one wrapper per client, and
do not also call `recordRequest` for the same request.

## What it records

Status, method, redacted URL, error type, and the time to response headers. The
event carries `durTo: "headers"`, which says the number excludes body download
and decoding.

Bodies and headers are never read. The response stream reaches the application
untouched, so a failure while reading the body afterwards is not captured. The
original exception is rethrown unchanged, and a capture failure never replaces
an HTTP result.

Requests to the Crumbtrail ingest host are skipped. Without that, an application
that wraps the same client the SDK's transport uses would record its own
delivery, and each recorded delivery would trigger the next.

Set `CrumbtrailCollectors(network: false)` to disable capture. The default is
`true`. Stopping Crumbtrail prevents further events.

## Verify

```bash
flutter test
```

In an application, issue a request through the wrapped client, flush Crumbtrail,
and inspect the session for a `net` event with the request status.
