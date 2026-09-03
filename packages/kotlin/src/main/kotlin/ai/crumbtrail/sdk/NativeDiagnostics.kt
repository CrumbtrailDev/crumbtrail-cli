package ai.crumbtrail.sdk

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

const val MAX_DIAGNOSTIC_STACK_CHARS = 8_192
const val MAX_DIAGNOSTIC_STACK_FRAMES = 64

private val diagnosticAuthorizationPattern = Regex(
    """(?i)(\b(?:proxy-)?authorization\b["']?[ \t]*[:=][ \t]*["']?)(?:bearer|basic)[ \t]+[^\s,;"']+""",
)

private val diagnosticCredentialPattern = Regex(
    """(?i)(\b(?:authorization|cookie|set-cookie|proxy-authorization|www-authenticate|x[-_]?api[-_]?key|x[-_]?auth[-_]?token|x[-_]?csrf[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|auth[-_]?(?:token|key)|token|secret|password|passwd|credential|signature|bearer)\b["']?\s*(?:[:=]\s*|\s+)["']?)([^\s,;"']+)""",
)

/** Text that may safely be included in a diagnostic event. */
fun boundedDiagnosticText(value: String?, maxChars: Int = MAX_DIAGNOSTIC_STACK_CHARS): String? {
    if (value.isNullOrEmpty() || maxChars <= 0) return null
    return if (value.length <= maxChars) value else value.take(maxChars)
}

/** Remove credential-shaped values from diagnostic text before it leaves the device. */
fun redactedDiagnosticText(value: String?, maxChars: Int = MAX_DIAGNOSTIC_STACK_CHARS): String? =
    boundedDiagnosticText(value, maxChars)?.replace(diagnosticAuthorizationPattern) {
        "${it.groupValues[1]}[REDACTED]"
    }?.replace(diagnosticCredentialPattern) {
        "${it.groupValues[1]}[REDACTED]"
    }?.let { boundedDiagnosticText(it, maxChars) }

/** A bounded stack avoids making a failure in the diagnostic path worse. */
fun boundedStackTrace(throwable: Throwable): String? = redactedDiagnosticText(
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
    val importIdentity: Any get() = this
    fun write(hang: CrumbtrailPendingHang)
    fun read(): CrumbtrailPendingHang?
    fun clear()

    /** Claim the single durable slot without racing another watchdog instance. */
    fun writeIfEmpty(hang: CrumbtrailPendingHang): Boolean {
        if (read() != null) return false
        write(hang)
        return read() == hang
    }

    /** Clear only the record this watchdog claimed, not a replacement record. */
    fun clearIfMatches(hang: CrumbtrailPendingHang): Boolean {
        if (read() != hang) return false
        clear()
        return true
    }
}

/** In-memory implementation for hosts that opt out of persistence and tests. */
class MemoryPendingHangStore(private var hang: CrumbtrailPendingHang? = null) :
    CrumbtrailPendingHangStore {
    private val lock = Any()
    override fun write(hang: CrumbtrailPendingHang) = synchronized(lock) { this.hang = hang }
    override fun read(): CrumbtrailPendingHang? = synchronized(lock) { hang }
    override fun clear() = synchronized(lock) { hang = null }
    override fun writeIfEmpty(hang: CrumbtrailPendingHang): Boolean = synchronized(lock) {
        if (this.hang != null) return@synchronized false
        this.hang = hang
        true
    }
    override fun clearIfMatches(hang: CrumbtrailPendingHang): Boolean = synchronized(lock) {
        if (this.hang != hang) return@synchronized false
        this.hang = null
        true
    }
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
    fun postToBackground(task: () -> Unit) {
        schedule(0, task)
    }
    fun drain() = Unit
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
    /** Returns true only when the host accepted the event into its logger. */
    private val onHang: (CrumbtrailNativeHang) -> Boolean,
    /** Monotonic milliseconds used only for elapsed-time calculations. */
    private val now: () -> Long = { System.nanoTime() / 1_000_000L },
    /** Wall-clock milliseconds used only for persisted event timestamps. */
    private val wallNow: () -> Long = System::currentTimeMillis,
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
    private var pendingHang: CrumbtrailPendingHang? = null
    private var pendingStartedMonotonic: Long? = null
    private var checkTask: CrumbtrailWatchdogTask? = null
    private var debuggerPollTask: CrumbtrailWatchdogTask? = null
    private var debuggerSuppressed = false

    init {
        require(checkIntervalMs > 0) { "checkIntervalMs must be positive" }
    }

    val threshold: Long get() = thresholdMs

    /** Start or resume the watchdog. A debugger suppresses the watchdog. */
    fun start() {
        if (debuggerAttached()) {
            suppressForDebugger()
            return
        }
        val token: Long
        synchronized(lock) {
            if (running) return
            debuggerSuppressed = false
            debuggerPollTask?.cancel()
            debuggerPollTask = null
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
            debuggerSuppressed = false
            generation += 1
            checkTask?.cancel()
            checkTask = null
            debuggerPollTask?.cancel()
            debuggerPollTask = null
        }
    }

    fun resume() = start()

    /** Stop and release the scheduler owned by this watchdog. */
    fun stop() {
        pause()
        scheduler.drain()
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
        if (debuggerAttached()) {
            suppressForDebugger()
            return
        }

        val current = now()
        synchronized(lock) {
            if (running && generation == token) {
                val elapsed = (current - lastHeartbeatAt).coerceAtLeast(0)
                if (elapsed >= thresholdMs && pendingHang == null && handoff.read() == null) {
                    val at = wallNow()
                    val pending = CrumbtrailPendingHang(
                        thresholdMs = thresholdMs,
                        observedDurationMs = elapsed.coerceAtMost(MAX_NATIVE_HANG_DURATION_MS),
                        stack = redactedDiagnosticText(captureStack()),
                        at = at,
                        startedAt = (at - elapsed).coerceAtLeast(0),
                    )
                    runCatching {
                        if (handoff.writeIfEmpty(pending)) {
                            pendingHang = pending
                            pendingStartedMonotonic = lastHeartbeatAt
                        }
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
            val pending = pendingHang
            observation = if (pending != null) {
                val duration = if (pendingStartedMonotonic != null) {
                    (current - pendingStartedMonotonic!!)
                        .coerceAtLeast(pending.observedDurationMs)
                        .coerceIn(0, MAX_NATIVE_HANG_DURATION_MS)
                } else {
                    pending.observedDurationMs.coerceIn(0, MAX_NATIVE_HANG_DURATION_MS)
                }
                pendingHang = null
                pendingStartedMonotonic = null
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
            if (observation != null) {
                val recoveredObservation = observation
                val expectedHang = checkNotNull(pending)
                scheduler.postToBackground {
                    withPendingHangClaim(handoff) {
                        val stillOwned = runCatching {
                            handoff.read() == expectedHang
                        }.getOrDefault(false)
                        if (!stillOwned) return@withPendingHangClaim false
                        val accepted = runCatching { onHang(recoveredObservation) }.getOrDefault(false)
                        if (accepted) runCatching { handoff.clearIfMatches(expectedHang) }
                        accepted
                    }
                }
            }
        }
    }

    private fun debuggerAttached(): Boolean = runCatching { isDebuggerAttached() }.getOrDefault(false)

    private fun suppressForDebugger() {
        val shouldPoll: Boolean
        synchronized(lock) {
            running = false
            generation += 1
            checkTask?.cancel()
            checkTask = null
            shouldPoll = !debuggerSuppressed
            debuggerSuppressed = true
        }
        if (shouldPoll) scheduleDebuggerPoll()
    }

    private fun scheduleDebuggerPoll() {
        synchronized(lock) {
            if (!debuggerSuppressed || running) return
            val task = scheduler.schedule(checkIntervalMs) { pollDebugger() }
            if (debuggerSuppressed && !running) debuggerPollTask = task else task.cancel()
        }
    }

    private fun pollDebugger() {
        val shouldPoll = synchronized(lock) { debuggerSuppressed }
        if (!shouldPoll) return
        if (debuggerAttached()) {
            scheduleDebuggerPoll()
            return
        }
        resumeAfterDebugger()
    }

    /** Transition out of debugger suppression atomically with the running state. */
    private fun resumeAfterDebugger() {
        val token: Long
        synchronized(lock) {
            if (!debuggerSuppressed || running) return
            debuggerSuppressed = false
            debuggerPollTask = null
            running = true
            generation += 1
            token = generation
            lastHeartbeatAt = now()
        }
        // Pause can win after the transition. scheduleCheck cancels its task
        // when it observes the newer generation, and the heartbeat is a no-op.
        scheduleCheck(token)
        scheduler.postToMain { heartbeat(token) }
    }

    companion object {
        const val DEFAULT_NATIVE_HANG_THRESHOLD_MS = 5_000L
        const val DEFAULT_NATIVE_HANG_CHECK_INTERVAL_MS = 250L
        const val MAX_NATIVE_HANG_DURATION_MS = 86_400_000L
    }
}

/**
 * Import a pending hang from the previous launch exactly once.
 *
 * The sink acknowledges that the event was accepted. A rejected event keeps
 * its durable handoff so a later launch can retry it.
 */
private val pendingHangImports = mutableSetOf<Any>()

fun drainPendingHang(
    handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Boolean,
): Boolean {
    return withPendingHangClaim(handoff) { drainClaimedPendingHang(handoff, onHang) }
}

private fun withPendingHangClaim(handoff: CrumbtrailPendingHangStore, action: () -> Boolean): Boolean {
    val identity = handoff.importIdentity
    if (!synchronized(pendingHangImports) { pendingHangImports.add(identity) }) return false
    try {
        return action()
    } finally {
        synchronized(pendingHangImports) { pendingHangImports.remove(identity) }
    }
}

private fun drainClaimedPendingHang(
    handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Boolean,
): Boolean {
    val pending = runCatching { handoff.read() }.getOrNull() ?: return false
    val accepted = runCatching {
        onHang(
            CrumbtrailNativeHang(
                thresholdMs = pending.thresholdMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                observedDurationMs = pending.observedDurationMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                recovered = false,
                previousLaunch = true,
                stack = redactedDiagnosticText(pending.stack),
            )
        )
    }.getOrDefault(false)
    if (accepted) runCatching { handoff.clearIfMatches(pending) }
    return accepted
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
    private val acknowledge: ((CrumbtrailProcessExit) -> Boolean)? = null,
) {
    fun collect() {
        val entries = runCatching { reader.read(MAX_PROCESS_EXIT_ENTRIES) }
            .getOrDefault(emptyList())
            .filter { it.timestamp > 0 }
            .take(MAX_PROCESS_EXIT_ENTRIES)
            .sortedByDescending { it.timestamp }
        if (entries.isEmpty()) return
        val seen = runCatching { marker.read() }.getOrNull()
        entries.asReversed()
            .filter { seen == null || it.timestamp > seen }
            .forEach { candidate ->
                val accepted = runCatching {
                    val bounded = candidate.copy(
                        description = redactedDiagnosticText(candidate.description, 1_024)
                    )
                    acknowledge?.invoke(bounded) ?: run {
                        emit(bounded)
                        true
                    }
                }.getOrDefault(false)
                if (!accepted) return
                runCatching { marker.write(candidate.timestamp) }
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

    override fun postToBackground(task: () -> Unit) {
        runCatching { executor.execute { runCatching(task) } }
    }

    override fun shutdown() {
        executor.shutdown()
    }

    override fun drain() {
        if (Thread.currentThread().name == "crumbtrail-native-watchdog") return
        runCatching {
            executor.submit {}.get(2, TimeUnit.SECONDS)
        }
    }
}
