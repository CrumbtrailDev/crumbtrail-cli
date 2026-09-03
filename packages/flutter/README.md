# crumbtrail_flutter

Flutter SDK for Crumbtrail session capture, on iOS, Android, macOS, Windows and
Linux.

Flutter draws its own UI rather than using platform widgets, so nothing a
WebView or native SDK captures applies here. This package hooks the two places
Flutter surfaces failure, records screen changes and app lifecycle alongside
them, and posts the result to the same ingest endpoint every other Crumbtrail
SDK uses.

## Install

`crumbtrail_flutter` is not on pub.dev yet, so `flutter pub add crumbtrail_flutter`
will not resolve and `npx crumbtrail` will not wire a Flutter app automatically.
Until it ships, depend on it from source:

```yaml
dependencies:
  crumbtrail_flutter:
    git:
      url: https://github.com/CrumbtrailDev/crumbtrail-cli.git
      path: packages/flutter
```

Once it is published this becomes the usual pair:

```yaml
dependencies:
  crumbtrail_flutter: ^0.1.0
```

```bash
flutter pub add crumbtrail_flutter
```

## Setup

```dart
import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  await Crumbtrail.start(const CrumbtrailConfig(
    endpoint: 'https://api.crumbtrail.ai',
    ingestKey: String.fromEnvironment('CRUMBTRAIL_KEY'),
    service: 'checkout-app',
  ));
  runApp(const MyApp());
}
```

`Crumbtrail.start` awaits `SharedPreferences` before it resolves the session, so
a session id from a previous launch is actually restored. It also drains the
optional Android or iOS native diagnostics plugin before returning. Call it
before `runApp` so startup errors and previous launch evidence are inside the
capture window. The plugin is registered automatically by Flutter when the
package is installed. On another platform the bridge reports unavailable and
the Dart SDK continues normally. The plugin starts its native collectors only
after `CrumbtrailCollectors.nativeDiagnostics` is enabled. When disabled, an
available plugin reports `supported: true, enabled: false` and drains no pending
native data.

Custom `nativeWatchdogHandoff` implementations must serialize their `deliver`
and `drain` methods. Keep each event durable until the acceptance callback
returns `true`, compare the stored value before clearing it, and return `false`
when any step fails. `Crumbtrail.stop()` waits for in-flight handoff work before
tearing down the native diagnostics platform.

`service` names which app in the project this is. One ingest key covers a whole
project, so without it every app in that project arrives as an anonymous
sender.

### Screen changes

Add the observer to your app's navigator. It works for `go_router`,
`auto_route`, and the imperative `Navigator` API alike, because they all drive
the same `Navigator` underneath.

```dart
MaterialApp(
  navigatorObservers: [CrumbtrailNavigatorObserver()],
  home: const HomeScreen(),
);
```

With `go_router`:

```dart
GoRouter(
  observers: [CrumbtrailNavigatorObserver()],
  routes: [...],
);
```

### Requests

Flutter has no single HTTP chokepoint the way a browser does, so requests are
recorded explicitly. This is deliberate: swallowing every request through a
global interceptor would capture requests from packages you did not choose to
instrument.

```dart
final started = DateTime.now();
final response = await client.get(url);
Crumbtrail.instance?.recordRequest(
  url: url.toString(),
  method: 'GET',
  status: response.statusCode,
  durationMs: DateTime.now().difference(started).inMilliseconds,
);
```

The URL is redacted before it is queued: userinfo, fragment and
credential-shaped query values are stripped on the device.

### Caught errors

```dart
try {
  await submitOrder();
} catch (error, stack) {
  Crumbtrail.instance?.recordError(error, stack);
}
```

## What is captured

| Signal | How |
| --- | --- |
| Framework errors | `FlutterError.onError` — a failed build, layout or paint |
| Async errors | `PlatformDispatcher.onError` — where an unawaited Future's failure lands |
| App lifecycle | `WidgetsBindingObserver`, including the flush on backgrounding |
| Native diagnostics | Previous launch native crash and hang evidence plus Android and iOS lifecycle evidence when the optional plugin is available |
| Dart hang | Foreground Dart event loop watchdog, disabled in debug mode by default |
| Screen changes | `CrumbtrailNavigatorObserver` |
| Environment | OS, OS version, locale and Dart version, from `dart:io` |
| Requests | `recordRequest`, redacted |

Both error surfaces are installed, and both chain to any handler already in
place, so adding Crumbtrail never silently removes a crash reporter you already
had. Installing only `FlutterError.onError` is the common mistake and it misses
exactly the async failures that produce the hardest bugs.

Nothing collected identifies a person. There is no device identifier, no
advertising id, no keystrokes and no request bodies.

## Configuration

| Option | Default | What it does |
| --- | --- | --- |
| `endpoint` | required | Ingest base URL |
| `ingestKey` | none | Your `ctkey_` project key |
| `service` | none | Which app in the project this is |
| `sessionIdleMs` | 30 minutes | Gap after which a new session starts |
| `queueCapacity` | 2000 | Pending events held before the oldest are dropped |
| `flushBatchSize` | 50 | Queue length that triggers an immediate send |
| `flushInterval` | 10 seconds | Periodic send |
| `collectors` | all on | Turn off errors, app lifecycle, environment, native diagnostics or the Dart watchdog |

Native diagnostics and the Dart watchdog are also controlled by
`CrumbtrailCollectors.nativeDiagnostics` and
`CrumbtrailCollectors.nativeWatchdog`. They are enabled by default. The
watchdog pauses when the app is not resumed and while a debugger is attached.

The ingest key is write only by design. It cannot read sessions back, so
shipping it in an app binary exposes nothing. Reading data needs a separate
agent key (`ctagt_`), which never belongs in an app.

## Delivery, and what happens when it fails

Three outcomes, and they are not the same thing:

- **Delivered.** A 2xx response.
- **Unreachable.** No response at all. The batch is put back at the *front* of
  the queue and retried, so the timeline keeps its order.
- **Refused.** The server answered with a non-2xx. The identical batch would be
  refused identically, so it is not retried; it is recorded as a capture gap on
  `Crumbtrail.instance.gaps`.

The queue is bounded. An app that logs in a tight loop, or spends ten minutes
offline, out-produces the transport, and an unbounded queue would grow until the
OS killed the app for memory. The oldest events are dropped, and the count is
available on `droppedEventCount` — a session that quietly lost events would
otherwise read exactly like a session where nothing happened.

## Dependencies

One Dart package: `shared_preferences`, for session continuity and bounded
watchdog handoff across launches. Device facts
come from `dart:io` rather than `device_info_plus`, and requests are posted with
`dart:io` `HttpClient` rather than `package:http`, so this package does not
force a version on anything already in your app.

## Wire contract

This SDK speaks the contract in
[`docs/specs/native-sdk-wire-contract.md`](../../docs/specs/native-sdk-wire-contract.md),
and its tests assert every event kind against the shared fixtures in
`test-fixtures/wire-contract/` — the same files the Swift and Kotlin SDKs are
held to. Changing a fixture fails all three at once, which is the point.

```bash
flutter test
```
