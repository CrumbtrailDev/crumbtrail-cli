# Crumbtrail for Swift

Native iOS SDK for Crumbtrail session capture. Speaks the same ingest contract as
every other Crumbtrail SDK, verified against the shared fixtures in
[`test-fixtures/wire-contract/`](../../test-fixtures/wire-contract) — see
[the contract spec](../../docs/specs/native-sdk-wire-contract.md).

Use this for a native Swift app. If your app is React Native use
[`crumbtrail-react-native`](../react-native); if it is Ionic or Capacitor use
[`crumbtrail-capacitor`](../capacitor).

## Install

The Swift SDK is built and tested in this repository but is not published as a
standalone Swift Package Manager dependency yet. Add the local package from an
app checkout:

```swift
.package(path: "../crumbtrail-cli/packages/swift")
```

In Xcode, choose **File → Add Package Dependencies → Add Local…** and select
`packages/swift`. No standalone Git URL or registry version is available until a
release publishes this package.

## Setup

```swift
import Crumbtrail

Crumbtrail.start(config: CrumbtrailConfig(
    endpoint: "https://api.crumbtrail.ai",
    ingestKey: ProcessInfo.processInfo.environment["CRUMBTRAIL_KEY"],
    service: "app"
))
```

Call it once, as early as possible — `application(_:didFinishLaunchingWithOptions:)`
or your `App.init`. Starting early is what lets the crash reporter pick up a
crash from the previous launch before anything else can fail.

### The ingest key

The key is an **ingest** key (`ctkey_`): write only, and it cannot read anything
back. Anything shipped inside an app binary is extractable by someone determined,
which is exactly why the read and write keys are split. Do not put a `ctagt_`
agent key in an app.

## What gets captured

| Event | Source |
| --- | --- |
| `native-crash` | An uncaught exception from the **previous** launch |
| `native-hang` | Foreground main thread stalls after recovery or on the next launch, when enabled |
| `err` | Errors you report with `recordError` |
| `net` | HTTP requests, when the URLProtocol is registered (see below) |
| `app-lifecycle` | Foreground, background, terminate, and memory warnings when app-lifecycle capture is enabled |
| `env` | Device, OS, app version and locale at startup; orientation on rotation |

### Crashes are reported on the next launch

A crash cannot report itself: by the time the handler runs the process is
unwinding and a network round trip will not finish. So the handler writes the
details to disk and the next launch sends them. A crash therefore appears in the
session **after** the one it ended, which is a property of the platform rather
than a limitation of this SDK.

Crumbtrail chains to any exception handler already installed rather than
replacing it, so adding this SDK does not silently disable an existing crash
reporter.

### Opt in to main thread hangs and MetricKit diagnostics

Native watchdogs and native diagnostics are disabled by default. Enable the
switches only after the app's capture consent has been granted:

```swift
Crumbtrail.start(config: CrumbtrailConfig(
    endpoint: "https://api.crumbtrail.ai",
    ingestKey: ProcessInfo.processInfo.environment["CRUMBTRAIL_KEY"],
    // Set these only after the app's capture consent has been granted.
    collectors: CrumbtrailCollectors(
        nativeWatchdog: true,
        nativeDiagnostics: true
    )
))
```

When enabled, the watchdog uses a five second threshold. It pauses when the app
becomes inactive or enters the background and while a debugger is attached. It
resumes polling when the debugger detaches. A missed heartbeat is written to a
bounded file in Application Support and emitted when the main thread recovers.
If the process never recovers, the next launch emits `native-hang` with
`previousLaunch: true` and `recovered: false`. Stacks are limited to 64 frames
and 8,192 characters. The handoff is cleared only after the logger accepts the
event. Atomic replacement temporary files are isolated in a bounded Application
Support directory and stale files are removed during later store access.

`nativeWatchdog` observes foreground and background state independently of
`appLifecycle`. You can disable lifecycle event capture without disabling hang
detection or causing background time to be reported as a hang.

On iOS 14 and newer, and macOS 12 and newer when the optional framework is
available, native diagnostics imports MetricKit diagnostics. Hang diagnostics
are emitted as `native-hang` and crash diagnostics as `native-crash`, both
marked as previous launch observations. MetricKit is not used on tvOS or
watchOS. The SDK does not install signal handlers or swizzle system classes.
Credential-shaped values in native diagnostic text are replaced with
`[REDACTED]` before storage or delivery. `Crumbtrail.start` installs
process-wide collectors, so call it once per process. Multiple `Crumbtrail`
instances created with `init` remain supported for manual event routing, but
they do not install platform collectors.

### Network capture needs one line from you

`URLSession.shared` cannot be reconfigured, so its traffic is not captured.
Register the protocol on the session you actually use:

```swift
let configuration = URLSessionConfiguration.default
configuration.protocolClasses =
    [CrumbtrailURLProtocol.self] + (configuration.protocolClasses ?? [])
let session = URLSession(configuration: configuration)

CrumbtrailURLProtocol.install(logger: Crumbtrail.shared!)
```

This uses `URLProtocol`, the documented interception seam, rather than swizzling
`URLSession`. Swizzling would capture `URLSession.shared` too, but it mutates a
system class at runtime, breaks unpredictably across OS releases, and has
repeatedly drawn app-review attention. A telemetry SDK is not worth a broken
release build.

Request and response **bodies are never read**. Status, method, timing and a
redacted URL are what an agent can act on; a body is the easiest way for an SDK
to become the reason a token leaves the device.

## Recording things yourself

```swift
Crumbtrail.shared?.recordError(error, source: "checkout")

Crumbtrail.shared?.addEvent(
    kind: .navigation,
    data: ["name": "CheckoutViewController", "path": "/checkout"]
)

Crumbtrail.shared?.addEvent(
    kind: .error,
    data: ["msg": "tap handler threw", "fatal": false],
    target: CrumbtrailTarget(role: "button", label: "Pay now", testID: "checkout-pay")
)
```

## Sessions

A session id is minted by the SDK, persisted in `UserDefaults`, and resumed on
the next launch **only while it is still fresh** (30 minutes idle by default).

Both halves matter. Resuming unconditionally stitches today's bug onto last
week's timeline. Never resuming turns a user's week of once-a-day intermittent
reports into unrelated single-event sessions, which is exactly the recurrence
signal worth having.

## Privacy

The SDK collects **no identifiers for a person**: no `identifierForVendor`, no
advertising id, no serial. It reports the hardware model (`iPhone15,2`) and OS
version, because those explain a bug, and a device identifier only tracks
someone.

Redaction is deny-biased and runs before anything leaves the device:

- Header values are dropped when the name looks like a credential — matched on a
  compacted form, so `X-API_Key`, `x-api-key` and `xApiKey` are all caught. The
  header *names* survive, because "the request carried an Authorization header"
  is diagnostic and harmless.
- URLs lose userinfo, the fragment (where OAuth tokens land after a redirect),
  and any query value whose key looks like a credential.
- Request and response bodies are never captured.
- Keystrokes and input values are never captured.

## Delivery and loss

Events are buffered and flushed on a batch size, on a timer, and on backgrounding
— the last reliable moment before iOS may suspend the process and never resume it.

The buffer is bounded (2,000 events by default). A hot logging loop or ten
minutes offline would otherwise grow it until the OS kills the app for memory,
turning the SDK into the crash it was installed to explain. When the buffer
overflows the **oldest** events go, and the count is exposed on
`droppedEventCount` rather than being silent.

A non-2xx response is treated as a refusal, not a delivery. Retrying an identical
refused batch would be refused identically, so it is recorded on `gaps` instead —
a session missing 200 events must not read like a session where nothing happened.
A genuine network failure *is* retried, with the batch put back at the front so
the timeline keeps its order.

## Configuration

```swift
CrumbtrailConfig(
    endpoint: "https://api.crumbtrail.ai",
    ingestKey: "ctkey_…",
    service: "app",
    sessionIdleMs: 30 * 60 * 1000,
    queueCapacity: 2000,
    flushBatchSize: 50,
    flushIntervalSeconds: 10,
    // Set these only after the app's capture consent has been granted.
    collectors: CrumbtrailCollectors(
        network: false,
        nativeWatchdog: true,
        nativeDiagnostics: true
    )
)
```

## Shutdown

```swift
await Crumbtrail.shared?.stop()
```

Flushes what is buffered, closes the session, and removes every observer.

## Requirements

iOS 13+, tvOS 13+, Swift 5.9+. macOS 10.15+ is supported so the contract,
session, queue, transport and redaction layers run under `swift test` with no
simulator; the UIKit collectors compile out there.

## License

MIT
