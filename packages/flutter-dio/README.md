# crumbtrail_flutter_dio

Dio capture for [Crumbtrail](https://crumbtrail.ai). Add one interceptor to the
Dio instance your application already uses and every request through it becomes
a `net` event on the session.

Its own package on purpose. Dart has no compile-only dependency, so anything
`crumbtrail_flutter` declares is a package every consumer has to resolve.
Putting `dio` in the SDK would mean an application pinned to Dio 4 could not run
`pub get` because of a capture adapter it never enabled.

## Install

```yaml
dependencies:
  crumbtrail_flutter: ^0.1.0
  crumbtrail_flutter_dio: ^0.1.0
```

## Use

```dart
import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:crumbtrail_flutter_dio/crumbtrail_flutter_dio.dart';
import 'package:dio/dio.dart';

final dio = Dio();
dio.interceptors.add(CrumbtrailDioInterceptor(Crumbtrail.instance!));
```

Start Crumbtrail before registering the interceptor. Register it once per Dio
instance, and do not also call `recordRequest` for the same request.

## What it records

Status, method, redacted URL, error type, and duration. The event carries
`durTo: "body"`, because a Dio response interceptor runs after the body has been
buffered and decoded, so the number covers more than the `package:http` and
OkHttp adapters report. With `ResponseType.stream`, Dio returns before the
stream is consumed, and a later stream read error is not captured.

Bodies and headers are never read. The original response, exception,
cancellation and stream reach the application untouched, and a capture failure
never replaces an HTTP result.

Requests to the Crumbtrail ingest host are skipped. Without that, an application
that hands Crumbtrail a Dio backed transport would record its own delivery, and
each recorded delivery would trigger the next.

Set `CrumbtrailCollectors(network: false)` to disable capture. The default is
`true`. Stopping Crumbtrail prevents further events.

## Known limit

The interceptor matches a response to its request through the `RequestOptions`
instance it saw in `onRequest`. An interceptor that replaces that instance, as a
retry interceptor does when it clones the options, breaks the match and the
request is not recorded. That case logs a line naming the method and path rather
than passing in silence, because a missing request otherwise reads exactly like
a session where the request never happened.

## Verify

```bash
flutter test
```

In an application, issue a request through the configured Dio instance, flush
Crumbtrail, and inspect the session for a `net` event with the request status.
