package ai.crumbtrail.sdk

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

object CrumbtrailSdk {
    const val NAME = "crumbtrail-kotlin"
    const val VERSION = "0.1.0"
    val descriptor = CrumbtrailSdkDescriptor(NAME, VERSION)
}

/**
 * A bounded, thread-safe buffer of pending events.
 *
 * Bounded on purpose. An app that logs in a tight loop, or spends ten minutes
 * offline in a lift, out-produces the transport. An unbounded queue answers that
 * by growing until Android kills the app for memory, turning a telemetry SDK
 * into the crash it was installed to explain. Dropping the oldest keeps the most
 * recent window, which is the window a bug is in — and the drops are counted,
 * because a session that quietly lost events reads exactly like a session where
 * nothing happened.
 */
class CrumbtrailEventQueue(capacity: Int = 2000) {
    private val capacity = maxOf(1, capacity)
    private val events = ArrayDeque<CrumbtrailEvent>()
    private val lock = Any()
    private var droppedCount = 0

    val dropped: Int get() = synchronized(lock) { droppedCount }
    val size: Int get() = synchronized(lock) { events.size }

    fun append(event: CrumbtrailEvent) = synchronized(lock) {
        events.addLast(event)
        trim()
    }

    fun drain(): List<CrumbtrailEvent> = synchronized(lock) {
        val taken = events.toList()
        events.clear()
        taken
    }

    /**
     * Put a failed batch back at the FRONT, preserving order. Re-appending at
     * the back would reorder a retried batch behind events that happened after
     * it, and an out-of-order timeline invents causality that never occurred.
     */
    fun requeue(batch: List<CrumbtrailEvent>) {
        if (batch.isEmpty()) return
        synchronized(lock) {
            batch.asReversed().forEach { events.addFirst(it) }
            trim()
        }
    }

    private fun trim() {
        while (events.size > capacity) {
            events.removeFirst()
            droppedCount++
        }
    }
}

/** A window of capture that was lost, and why. */
data class CrumbtrailCaptureGap(val eventCount: Int, val reason: String, val at: Long)

data class CrumbtrailCollectors(
    val errors: Boolean = true,
    val network: Boolean = true,
    val appLifecycle: Boolean = true,
    val navigation: Boolean = true,
    val environment: Boolean = true,
)

data class CrumbtrailConfig(
    val endpoint: String,
    /** Ingest key (`ctkey_`). Write only by design. */
    val ingestKey: String? = null,
    /**
     * Which app in the project this is. One key covers a whole project, so
     * without this every app in it ingests as an anonymous sender.
     */
    val service: String? = null,
    /**
     * Thirty minutes matches the browser SDK: long enough that a user who
     * backgrounds the app to read an email resumes the same session, short
     * enough that yesterday's is never stitched onto today's bug.
     */
    val sessionIdleMs: Long = 30 * 60 * 1000,
    val queueCapacity: Int = 2000,
    val flushBatchSize: Int = 50,
    val flushIntervalSeconds: Long = 10,
    val collectors: CrumbtrailCollectors = CrumbtrailCollectors(),
)

/** Facts about the running app and device. */
data class CrumbtrailDeviceInfo(
    val model: String? = null,
    val manufacturer: String? = null,
    val os: String? = null,
    val osVersion: String? = null,
    val appId: String? = null,
    val appVersion: String? = null,
    val appBuild: String? = null,
    val locale: String? = null,
) {
    // Unknown fields are omitted rather than sent blank: an absent field and an
    // empty string are different claims, and only the first one is honest.
    fun deviceJson(): JsonValue = JsonValue.of(
        "model" to JsonValue.str(model),
        "manufacturer" to JsonValue.str(manufacturer),
        "os" to JsonValue.str(os),
        "osVersion" to JsonValue.str(osVersion),
    )

    fun appJson(): JsonValue = JsonValue.of(
        "id" to JsonValue.str(appId),
        "version" to JsonValue.str(appVersion),
        "build" to JsonValue.str(appBuild),
    )
}

/**
 * The capture session.
 *
 * Free of Android types by design: the platform bindings live in
 * [ai.crumbtrail.sdk.android] and feed this. That split is what lets the whole
 * of the interesting behaviour — session expiry, delivery outcomes, queue
 * bounds, redaction — run under plain `gradle test` with no emulator.
 */
class Crumbtrail(
    val config: CrumbtrailConfig,
    private val transport: CrumbtrailTransport,
    private val store: CrumbtrailSessionStore = MemorySessionStore(),
    deviceInfo: CrumbtrailDeviceInfo = CrumbtrailDeviceInfo(),
    val platform: CrumbtrailPlatform = CrumbtrailPlatform.ANDROID,
    private val capabilities: List<String> = emptyList(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val scheduler: ScheduledExecutorService? =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            // Daemon, so a running flush timer can never hold the JVM (or a
            // test run) open after the app is done with it.
            Thread(runnable, "crumbtrail-flush").apply { isDaemon = true }
        },
) {
    val sessionId: String
    private val queue = CrumbtrailEventQueue(config.queueCapacity)
    private val gapLock = Any()
    private val _gaps = mutableListOf<CrumbtrailCaptureGap>()
    private var stopped = false
    private val cleanups = mutableListOf<() -> Unit>()

    val gaps: List<CrumbtrailCaptureGap> get() = synchronized(gapLock) { _gaps.toList() }
    val droppedEventCount: Int get() = queue.dropped

    init {
        val session = CrumbtrailSessionResolver.resolve(store, config.sessionIdleMs, clock())
        sessionId = session.id

        transport.startSession(
            sessionId,
            JsonValue.of(
                "service" to JsonValue.str(config.service),
                "platform" to JsonValue.Str(platform.wireValue),
                "app" to deviceInfo.appJson(),
                "device" to deviceInfo.deviceJson(),
            ),
        )

        if (config.collectors.environment) {
            addEvent(
                CrumbtrailEventKind.ENVIRONMENT,
                JsonValue.of(
                    "kind" to JsonValue.Str("snapshot"),
                    "device" to deviceInfo.deviceJson(),
                    "app" to deviceInfo.appJson(),
                    "locale" to JsonValue.str(deviceInfo.locale),
                ),
            )
        }

        scheduler?.takeIf { config.flushIntervalSeconds > 0 }?.scheduleWithFixedDelay(
            { runCatching { flush() } },
            config.flushIntervalSeconds,
            config.flushIntervalSeconds,
            TimeUnit.SECONDS,
        )
    }

    fun addEvent(kind: CrumbtrailEventKind, data: JsonValue, target: CrumbtrailTarget? = null) =
        addEvent(kind.wireValue, data, target)

    fun addEvent(kind: String, data: JsonValue, target: CrumbtrailTarget? = null) {
        if (stopped) return
        queue.append(
            CrumbtrailEvent(
                timestamp = clock(),
                kind = kind,
                data = data,
                platform = platform,
                sdk = CrumbtrailSdk.descriptor,
                capabilities = capabilities,
                target = target,
            )
        )
        // Touch the session so a resumed one does not expire mid-use.
        store.write(PersistedSession(sessionId, clock()))
        if (queue.size >= config.flushBatchSize) flush()
    }

    /** Record a caught error. `fatal` stays false: the process survived. */
    fun recordError(throwable: Throwable, fatal: Boolean = false, source: String = "manual") {
        addEvent(
            CrumbtrailEventKind.ERROR,
            JsonValue.of(
                "msg" to JsonValue.Str(throwable.message ?: throwable.toString()),
                "stk" to JsonValue.str(throwable.stackTraceToString()),
                "fatal" to JsonValue.Bool(fatal),
                "source" to JsonValue.Str(source),
            ),
        )
    }

    /** Record a completed request. The URL goes through redaction first. */
    fun recordRequest(
        url: String,
        method: String,
        status: Int?,
        durationMs: Long,
        source: String = "okhttp",
        error: String? = null,
    ) {
        addEvent(
            CrumbtrailEventKind.NETWORK,
            JsonValue.of(
                "url" to JsonValue.Str(CrumbtrailRedaction.redactUrl(url)),
                "method" to JsonValue.Str(method.uppercase()),
                "status" to JsonValue.num(status),
                "ok" to JsonValue.bool(status?.let { it in 200..299 }),
                "dur" to JsonValue.Num(durationMs),
                "source" to JsonValue.Str(source),
                "error" to JsonValue.str(error),
            ),
        )
    }

    /**
     * Send everything buffered.
     *
     * A refusal is not retried: the server already answered, and the identical
     * batch would be refused identically, so it becomes a declared gap. A
     * network failure IS retried, with the batch put back at the front so the
     * timeline keeps its order.
     */
    fun flush() {
        val batch = queue.drain()
        if (batch.isEmpty()) return
        try {
            transport.sendEvents(sessionId, batch)
        } catch (error: CrumbtrailDeliveryException.Refused) {
            synchronized(gapLock) {
                _gaps.add(CrumbtrailCaptureGap(error.eventCount, "refused-${error.status}", clock()))
            }
        } catch (_: Exception) {
            queue.requeue(batch)
        }
    }

    fun registerCleanup(cleanup: () -> Unit) {
        cleanups.add(cleanup)
    }

    fun stop() {
        if (stopped) return
        stopped = true
        cleanups.asReversed().forEach { runCatching(it) }
        cleanups.clear()
        scheduler?.shutdownNow()
        flush()
        transport.endSession(sessionId)
    }
}
