package ai.crumbtrail.sdk

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

const val MAX_DIAGNOSTIC_STACK_CHARS = 8_192
const val MAX_DIAGNOSTIC_STACK_FRAMES = 64

/** Text that may safely be included in a diagnostic event. */
fun boundedDiagnosticText(value: String?, maxChars: Int = MAX_DIAGNOSTIC_STACK_CHARS): String? {
    if (value.isNullOrEmpty() || maxChars <= 0) return null
    return if (value.length <= maxChars) value else value.take(maxChars)
}

/** A bounded stack avoids making a failure in the diagnostic path worse. */
fun boundedStackTrace(throwable: Throwable): String? = boundedDiagnosticText(
    buildString {
        append(throwable.toString())
        throwable.stackTrace
            .take(MAX_DIAGNOSTIC_STACK_FRAMES)
            .forEach {
                append('\n')
                append("\tat ")
                append(it)
            }
    },
)

/** A hang detected in this launch and handed off until the main thread recovers. */
data class CrumbtrailPendingHang(
    val thresholdMs: Long,
    val observedDurationMs: Long,
    val stack: String?,
    val at: Long,
    /** Start of the missed heartbeat window, distinct from detection time. */
    val startedAt: Long = at,
)

/** Durable handoff for a watchdog event that cannot safely be delivered yet. */
interface CrumbtrailPendingHangStore {
    fun write(hang: CrumbtrailPendingHang)
    fun read(): CrumbtrailPendingHang?
    fun clear()
}

/** In-memory implementation for hosts that opt out of persistence and tests. */
class MemoryPendingHangStore(private var hang: CrumbtrailPendingHang? = null) :
    CrumbtrailPendingHangStore {
    private val lock = Any()
    override fun write(hang: CrumbtrailPendingHang) = synchronized(lock) { this.hang = hang }
    override fun read(): CrumbtrailPendingHang? = synchronized(lock) { hang }
    override fun clear() = synchronized(lock) { hang = null }
}

/** One watchdog observation in the shared native-hang shape. */
data class CrumbtrailNativeHang(
    val thresholdMs: Long,
    val observedDurationMs: Long,
    val recovered: Boolean,
    val previousLaunch: Boolean,
    val stack: String?,
)

/** A cancellable task supplied by the platform scheduler. */
fun interface CrumbtrailWatchdogTask {
    fun cancel()
}

/** Scheduling and main-thread posting seam. Android supplies the real one. */
interface CrumbtrailWatchdogScheduler {
    fun schedule(delayMs: Long, task: () -> Unit): CrumbtrailWatchdogTask
    fun postToMain(task: () -> Unit)
    fun shutdown() = Unit
}

/**
 * Foreground-only main-thread watchdog state machine.
 *
 * The checker runs away from the main thread and posts a heartbeat back to it.
 * When the heartbeat misses the threshold a bounded record is written to the
 * handoff store. The record is emitted only after recovery, or imported by the
 * next launch if the process never recovers. This keeps the network and the
 * logger out of the blocked thread's critical path.
 */
class CrumbtrailMainThreadWatchdog(
    private val scheduler: CrumbtrailWatchdogScheduler,
    private val handoff: CrumbtrailPendingHangStore,
    private val onHang: (CrumbtrailNativeHang) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val isDebuggerAttached: () -> Boolean = { false },
    thresholdMs: Long = DEFAULT_NATIVE_HANG_THRESHOLD_MS,
    private val checkIntervalMs: Long = DEFAULT_NATIVE_HANG_CHECK_INTERVAL_MS,
    private val captureStack: () -> String? = { null },
) {
    private val lock = Any()
    private val thresholdMs = thresholdMs.coerceIn(1, MAX_NATIVE_HANG_DURATION_MS)
    private var running = false
    private var generation = 0L
    private var lastHeartbeatAt = 0L
    private var pendingAt: Long? = null
    private var checkTask: CrumbtrailWatchdogTask? = null

    init {
        require(checkIntervalMs > 0) { "checkIntervalMs must be positive" }
    }

    val threshold: Long get() = thresholdMs

    /** Start or resume the watchdog. A debugger suppresses the watchdog. */
    fun start() {
        if (isDebuggerAttached()) {
            pause()
            return
        }
        val token: Long
        synchronized(lock) {
            if (running) return
            running = true
            generation += 1
            token = generation
            lastHeartbeatAt = now()
        }
        scheduleCheck(token)
        scheduler.postToMain { heartbeat(token) }
    }

    /** Pause while the app is backgrounded or inactive. */
    fun pause() {
        synchronized(lock) {
            running = false
            generation += 1
            checkTask?.cancel()
            checkTask = null
        }
    }

    fun resume() = start()

    /** Stop and release the scheduler owned by this watchdog. */
    fun stop() {
        pause()
        scheduler.shutdown()
    }

    private fun scheduleCheck(token: Long) {
        val task = scheduler.schedule(checkIntervalMs) { check(token) }
        synchronized(lock) {
            if (running && generation == token) checkTask = task else task.cancel()
        }
    }

    private fun check(token: Long) {
        val shouldContinue: Boolean
        synchronized(lock) { shouldContinue = running && generation == token }
        if (!shouldContinue) return
        if (isDebuggerAttached()) {
            pause()
            return
        }

        val current = now()
        synchronized(lock) {
            if (running && generation == token) {
                val elapsed = (current - lastHeartbeatAt).coerceAtLeast(0)
                if (elapsed >= thresholdMs && pendingAt == null && handoff.read() == null) {
                    val at = current
                    runCatching {
                        handoff.write(
                            CrumbtrailPendingHang(
                                thresholdMs = thresholdMs,
                                observedDurationMs = elapsed.coerceAtMost(MAX_NATIVE_HANG_DURATION_MS),
                                stack = boundedDiagnosticText(captureStack()),
                                at = at,
                                startedAt = lastHeartbeatAt,
                            )
                        )
                        pendingAt = at
                    }
                }
            }
        }

        scheduler.postToMain { heartbeat(token) }
        scheduleCheck(token)
    }

    private fun heartbeat(token: Long) {
        val observation: CrumbtrailNativeHang?
        synchronized(lock) {
            if (!running || generation != token) return
            val current = now()
            val pending = handoff.read()
            val activeAt = pendingAt
            observation = if (activeAt != null && pending != null && pending.at == activeAt) {
                val duration = (current - pending.startedAt).coerceAtLeast(pending.observedDurationMs)
                    .coerceAtMost(MAX_NATIVE_HANG_DURATION_MS)
                runCatching { handoff.clear() }
                pendingAt = null
                CrumbtrailNativeHang(
                    thresholdMs = pending.thresholdMs,
                    observedDurationMs = duration,
                    recovered = true,
                    previousLaunch = false,
                    stack = pending.stack,
                )
            } else {
                null
            }
            lastHeartbeatAt = current
        }
        observation?.let { runCatching { onHang(it) } }
    }

    companion object {
        const val DEFAULT_NATIVE_HANG_THRESHOLD_MS = 5_000L
        const val DEFAULT_NATIVE_HANG_CHECK_INTERVAL_MS = 250L
        const val MAX_NATIVE_HANG_DURATION_MS = 86_400_000L
    }
}

/** Import a pending hang from the previous launch exactly once. */
fun drainPendingHang(
    handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Unit,
) {
    val pending = runCatching { handoff.read() }.getOrNull() ?: return
    runCatching { handoff.clear() }
    runCatching {
        onHang(
            CrumbtrailNativeHang(
                thresholdMs = pending.thresholdMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                observedDurationMs = pending.observedDurationMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                recovered = false,
                previousLaunch = true,
                stack = boundedDiagnosticText(pending.stack),
            )
        )
    }
}

/** Shared app-lifecycle process-exit observation. */
data class CrumbtrailProcessExit(
    val reason: String,
    val timestamp: Long,
    val importance: Int? = null,
    val status: Int? = null,
    val description: String? = null,
)

interface CrumbtrailProcessExitReader {
    fun read(maxEntries: Int): List<CrumbtrailProcessExit>
}

interface CrumbtrailProcessExitMarker {
    fun read(): Long?
    fun write(timestamp: Long)
}

/** Emits each newly observed process exit once, with bounded diagnostic text. */
class CrumbtrailProcessExitCollector(
    private val reader: CrumbtrailProcessExitReader,
    private val marker: CrumbtrailProcessExitMarker,
    private val emit: (CrumbtrailProcessExit) -> Unit,
) {
    fun collect() {
        val entries = runCatching { reader.read(MAX_PROCESS_EXIT_ENTRIES) }
            .getOrDefault(emptyList())
            .filter { it.timestamp > 0 }
            .sortedByDescending { it.timestamp }
        if (entries.isEmpty()) return
        val seen = runCatching { marker.read() }.getOrNull()
        val newest = entries.first()
        val candidate = entries.firstOrNull { seen == null || it.timestamp > seen }
            ?: return
        runCatching {
            emit(candidate.copy(description = boundedDiagnosticText(candidate.description, 1_024)))
            marker.write(newest.timestamp)
        }
    }

    companion object { const val MAX_PROCESS_EXIT_ENTRIES = 8 }
}

/** A tiny scheduler backed by a daemon thread for Android's compile-only seam. */
class CrumbtrailExecutorWatchdogScheduler : CrumbtrailWatchdogScheduler {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(
        ThreadFactory { runnable ->
            Thread(runnable, "crumbtrail-native-watchdog").apply { isDaemon = true }
        },
    )
    private val mainPoster: (Runnable) -> Unit

    constructor(mainPoster: (Runnable) -> Unit) {
        this.mainPoster = mainPoster
    }

    override fun schedule(delayMs: Long, task: () -> Unit): CrumbtrailWatchdogTask {
        val future: ScheduledFuture<*> = try {
            executor.schedule({ runCatching(task) }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            return CrumbtrailWatchdogTask { }
        }
        return CrumbtrailWatchdogTask { future.cancel(false) }
    }

    override fun postToMain(task: () -> Unit) {
        runCatching { mainPoster(Runnable { runCatching(task) }) }
    }

    override fun shutdown() {
        executor.shutdownNow()
    }
}
