# Crumbtrail for Kotlin

Native Android SDK for Crumbtrail session capture. Speaks the same ingest
contract as every other Crumbtrail SDK, verified against the shared fixtures in
[`test-fixtures/wire-contract/`](../../test-fixtures/wire-contract) — see
[the contract spec](../../docs/specs/native-sdk-wire-contract.md).

Use this for a native Android app. If your app is React Native use
[`crumbtrail-react-native`](../react-native); Ionic or Capacitor, use
[`crumbtrail-capacitor`](../capacitor); Flutter, use
[`crumbtrail_flutter`](../flutter).

## Install

```kotlin
dependencies {
    implementation("ai.crumbtrail:crumbtrail-kotlin:0.1.0")
}
```

The SDK needs the internet permission, which most apps already declare:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

It pulls in **no transitive dependencies** — not OkHttp, not a JSON library.
That is deliberate: a telemetry SDK is a dependency of someone else's app, and
every library it drags in is a version conflict in a build its author will never
see. HTTP goes through `HttpURLConnection` and JSON through a few hundred lines
in this package.

## Setup

```kotlin
class DemoApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        startCrumbtrail(
            application = this,
            config = CrumbtrailConfig(
                endpoint = "https://api.crumbtrail.ai",
                ingestKey = BuildConfig.CRUMBTRAIL_KEY,
                service = "app",
            ),
        )
    }
}
```

Call it from `Application.onCreate`, not an Activity. Starting there is what
gets the crash handler installed before anything else has a chance to fail.

### The ingest key

The key is an **ingest** key (`ctkey_`): write only, and it cannot read anything
back. Anything shipped inside an APK is extractable by someone determined, which
is exactly why the read and write keys are split. Never put a `ctagt_` agent key
in an app.

## What gets captured

| Event | Source |
| --- | --- |
| `native-crash` | An uncaught exception, delivered on the next launch |
| `native-hang` | Foreground main thread stalls after recovery or on the next launch |
| `err` | Errors you report with `recordError` |
| `net` | HTTP requests you report with `recordRequest` |
| `app-lifecycle` | Foreground and background transitions, process exits on API 30 and newer, and memory pressure |
| `navigation` | Which Activity came to the front |
| `env` | Device, OS, app version and locale at startup |

### Crashes

A crash handler cannot deliver its own crash. The default handler runs on the
crashing thread, which for most Android crashes is the main thread, and any
network call there is answered with `NetworkOnMainThreadException` — so the
handler writes the crash to `SharedPreferences` and the next launch sends it as a
`native-crash` with `source: "previous-launch"`. iOS defers for the same reason.

The record is cleared before it is sent, not after. If delivery were what cleared
it and delivery kept failing, the same crash would be re-reported on every launch
forever.

The cost is honest and worth stating: a crash on a user's last ever launch of the
app is never reported.

Crumbtrail always chains to whatever handler was already installed, so adding
this SDK does not silently disable an existing crash reporter.

### Main thread hangs and process exits

The default configuration watches the foreground main thread with a five second
threshold. The watchdog pauses when the app enters the background and while a
debugger is attached. It automatically resumes polling when the debugger
detaches. A missed heartbeat is written to `SharedPreferences` and emitted when
the main thread recovers. If the process never recovers, the next launch emits
`native-hang` with `previousLaunch: true` and `recovered: false`. Stacks are
limited to 64 frames and 8,192 characters. A previous launch handoff is read
and recorded on the watchdog executor. It is cleared only after the event is
accepted by the logger, so stopping the logger or rejecting the event leaves it
for the next launch.

On Android API 30 and newer the SDK also reads `ApplicationExitInfo` for the
most recent ANR, crash, native crash, or low memory exit. These observations are
sent as `app-lifecycle` with `state: "process-exit"`. `ComponentCallbacks2`
memory pressure notifications are sent as `app-lifecycle` with
`state: "memory-pressure"`.

### Network

There is no automatic interception. Android apps use OkHttp, Retrofit, Ktor and
`HttpURLConnection` in roughly equal measure, and an SDK that reached into any
one of them would either miss most apps or break on a version bump. Report from
wherever your app already has an interceptor:

```kotlin
class CrumbtrailInterceptor(private val logger: Crumbtrail) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val startedAt = System.currentTimeMillis()
        val request = chain.request()
        return try {
            chain.proceed(request).also { response ->
                logger.recordRequest(
                    url = request.url.toString(),
                    method = request.method,
                    status = response.code,
                    durationMs = System.currentTimeMillis() - startedAt,
                )
            }
        } catch (error: IOException) {
            logger.recordRequest(
                url = request.url.toString(),
                method = request.method,
                status = null,
                durationMs = System.currentTimeMillis() - startedAt,
                error = error.message,
            )
            throw error
        }
    }
}
```

`recordRequest` redacts the URL for you. Bodies are never captured.

## Recording things yourself

```kotlin
logger.recordError(error, source = "checkout")

logger.addEvent(
    CrumbtrailEventKind.NAVIGATION,
    JsonValue.of("name" to JsonValue.Str("CheckoutFragment"), "path" to JsonValue.Str("/checkout")),
)

logger.addEvent(
    CrumbtrailEventKind.ERROR,
    JsonValue.of("msg" to JsonValue.Str("tap handler threw")),
    target = CrumbtrailTarget(role = "button", label = "Pay now", testID = "checkout-pay"),
)
```

## Sessions

A session id is minted by the SDK, persisted in `SharedPreferences`, and resumed
on the next launch **only while it is still fresh** (30 minutes idle by default).

Both halves matter. Resuming unconditionally stitches today's bug onto last
week's timeline. Never resuming turns a user's week of once-a-day intermittent
reports into unrelated single-event sessions, which is exactly the recurrence
signal worth having.

`SharedPreferences` rather than the cache directory, which Android clears under
storage pressure.

## Privacy

The SDK collects **no identifiers for a person**: no `ANDROID_ID`, no advertising
id, no hardware serial. It reports `Build.MODEL` and the OS version, because
those explain a bug, and a device identifier only tracks someone.

Redaction is deny-biased and runs before anything leaves the device:

- Header values are dropped when the name looks like a credential — matched on a
  compacted form, so `X-API_Key`, `x-api-key` and `xApiKey` are all caught. The
  header *names* survive, because "the request carried an Authorization header"
  is diagnostic and harmless.
- URLs lose userinfo, the fragment (where OAuth tokens land after a redirect),
  and any query value whose key looks like a credential.
- Request and response bodies are never captured.

## Delivery and loss

Events are buffered and flushed on a batch size, on a timer, and when the app
goes to the background — the last reliable moment before Android may kill the
process.

Every delivery runs on the SDK's own daemon thread, never on the thread that
called in. That is not a detail: the session announce happens in
`Application.onCreate` and the background flush in an activity lifecycle
callback, both of them main thread, where the platform's default StrictMode
policy throws `NetworkOnMainThreadException` for any network operation. One
thread rather than a pool, so batches leave in the order they were captured.

`stop()` is the exception that waits: it flushes and closes the session, and
blocks for up to two seconds so a caller shutting the SDK down knows the tail of
the session left the device.

The buffer is bounded (2,000 events by default). A hot logging loop or ten
minutes offline would otherwise grow it until the OS kills the app for memory,
turning the SDK into the crash it was installed to explain. On overflow the
**oldest** events go, and the count is exposed on `droppedEventCount` rather than
being silent.

A non-2xx response is treated as a refusal, not a delivery. Retrying an identical
refused batch would be refused identically, so it is recorded on `gaps` instead —
a session missing 200 events must not read like a session where nothing happened.
A genuine network failure *is* retried, with the batch put back at the front so
the timeline keeps its order.

## Configuration

```kotlin
CrumbtrailConfig(
    endpoint = "https://api.crumbtrail.ai",
    ingestKey = "ctkey_…",
    service = "app",
    sessionIdleMs = 30 * 60 * 1000,
    queueCapacity = 2000,
    flushBatchSize = 50,
    flushIntervalSeconds = 10,
    collectors = CrumbtrailCollectors(
        navigation = false,
        nativeWatchdog = true,
        nativeDiagnostics = true,
    ),
)
```

## Shutdown

```kotlin
logger.stop()
```

Flushes what is buffered, closes the session, and unregisters every callback.

## Building and testing

```bash
gradle test
```

Built as a plain Kotlin/JVM library with `android.jar` on the **compile-only**
classpath, rather than through the Android Gradle Plugin. This SDK is pure code
with no resources or manifest entries, so it needs no AAR, and the plain-JVM
build means the whole suite runs on any JDK with no emulator and no AGP/Gradle
version dance. A suite that only runs in one specific Android toolchain is a
suite that stops running.

`android.jar` is located from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the Homebrew
commandlinetools path. Without it the Android bindings are skipped and the rest
still builds and tests.

## Requirements

Android API 21+, JDK 21+ to build.

## License

MIT
