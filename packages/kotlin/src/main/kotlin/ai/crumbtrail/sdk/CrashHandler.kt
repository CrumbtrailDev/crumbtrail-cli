package ai.crumbtrail.sdk

/** Crash details written by a dying process and read by the next launch. */
data class CrumbtrailPendingCrash(
    val message: String,
    val stack: String?,
    val thread: String?,
    val at: Long,
)

/**
 * The on-disk handoff between a crashing process and the next launch.
 *
 * Kept free of Android types so the handoff rule is testable under plain
 * `gradle test`; the platform binding supplies a `SharedPreferences` backed
 * implementation.
 */
interface CrumbtrailPendingCrashStore {
    fun write(crash: CrumbtrailPendingCrash)
    fun read(): CrumbtrailPendingCrash?
    fun clear()
}

/** In-memory store, for tests and for a host that opts out of persistence. */
class MemoryPendingCrashStore(private var crash: CrumbtrailPendingCrash? = null) :
    CrumbtrailPendingCrashStore {
    override fun write(crash: CrumbtrailPendingCrash) { this.crash = crash }
    override fun read(): CrumbtrailPendingCrash? = crash
    override fun clear() { crash = null }
}

/** One process-wide crash handler shared by all active logger instances. */
private object CrumbtrailCrashHandlerRegistry {
    private val lock = Any()
    private val registrations = LinkedHashMap<Any, CrumbtrailPendingCrashStore>()
    private var previous: Thread.UncaughtExceptionHandler? = null
    private var installed: Thread.UncaughtExceptionHandler? = null

    fun install(store: CrumbtrailPendingCrashStore): () -> Unit {
        val token = Any()
        synchronized(lock) {
            if (registrations.isEmpty()) {
                previous = Thread.getDefaultUncaughtExceptionHandler()
                val handler = Thread.UncaughtExceptionHandler { thread, throwable ->
                    // The newest logger owns the active capture path. This matters
                    // for tests and hosts that temporarily run more than one
                    // logger with distinct stores: stopping the newer logger must
                    // reveal the older one again, not leave a stale store active.
                    val activeStore = synchronized(lock) { registrations.values.lastOrNull() }
                    runCatching {
                        activeStore?.write(
                            CrumbtrailPendingCrash(
                                message = redactedDiagnosticText(
                                    throwable.message ?: throwable.toString(),
                                    1_024,
                                ) ?: "uncaught exception",
                                stack = boundedStackTrace(throwable),
                                thread = redactedDiagnosticText(thread.name, 256),
                                at = System.currentTimeMillis(),
                            )
                        )
                    }
                    synchronized(lock) { previous }?.uncaughtException(thread, throwable)
                }
                installed = handler
                Thread.setDefaultUncaughtExceptionHandler(handler)
            }
            registrations[token] = store
        }
        return { remove(token) }
    }

    private fun remove(token: Any) {
        synchronized(lock) {
            registrations.remove(token)
            if (registrations.isNotEmpty()) return
            if (Thread.getDefaultUncaughtExceptionHandler() === installed) {
                Thread.setDefaultUncaughtExceptionHandler(previous)
            }
            installed = null
            previous = null
        }
    }
}

/**
 * Capture an uncaught exception, and report it on the NEXT launch.
 *
 * A crash handler cannot deliver its own crash. The process is already going
 * down, and the only thing that could carry the report out — the network — is
 * exactly what must not be touched from here: the default handler runs on the
 * crashing thread, which for the large majority of Android crashes (UI code,
 * lifecycle callbacks, view inflation) is the main thread, and the platform's
 * default StrictMode policy answers a network call there with
 * `NetworkOnMainThreadException`. That is a `RuntimeException`, so it was caught
 * by [Crumbtrail.flush]'s catch-all, the batch was requeued into memory, and the
 * process died with the crash still in it.
 *
 * So the handler does the only thing that is safe here — writes to disk — and
 * the next launch delivers it. That matches the iOS SDK, which defers for the
 * same reason.
 *
 * It always chains to the previous handler. Replacing it outright would silently
 * disable whatever crash reporting the host already had.
 */
fun installCrashHandler(
    logger: Crumbtrail,
    crashStore: CrumbtrailPendingCrashStore,
) {
    drainPendingCrash(logger, crashStore)
    logger.registerCleanup(CrumbtrailCrashHandlerRegistry.install(crashStore))
}

/**
 * Read and clear anything the previous launch's crash handler left behind.
 *
 * Cleared before delivery, not after. If delivery is what clears the record and
 * delivery keeps failing, the same crash is re-reported on every launch forever;
 * a crash reported once and occasionally lost beats one that floods a session.
 */
internal fun drainPendingCrash(
    logger: Crumbtrail,
    crashStore: CrumbtrailPendingCrashStore,
) {
    val pending = runCatching { crashStore.read() }.getOrNull() ?: return
    runCatching { crashStore.clear() }
    logger.addEvent(
        CrumbtrailEventKind.NATIVE_CRASH,
        JsonValue.of(
            "msg" to JsonValue.Str(redactedDiagnosticText(pending.message, 1_024) ?: "uncaught exception"),
            "stk" to JsonValue.str(redactedDiagnosticText(pending.stack)),
            "fatal" to JsonValue.Bool(true),
            "thread" to JsonValue.str(redactedDiagnosticText(pending.thread, 256)),
            // Names both what happened and when it was recovered, so a reader
            // is never left thinking the crash happened at relaunch time.
            "source" to JsonValue.Str("previous-launch"),
            "at" to JsonValue.Num(pending.at),
        ),
    )
}
