package ai.crumbtrail.sdk.android

import ai.crumbtrail.sdk.Crumbtrail
import ai.crumbtrail.sdk.CrumbtrailConfig
import ai.crumbtrail.sdk.CrumbtrailDeviceInfo
import ai.crumbtrail.sdk.CrumbtrailEventKind
import ai.crumbtrail.sdk.CrumbtrailHttpTransport
import ai.crumbtrail.sdk.CrumbtrailPendingCrash
import ai.crumbtrail.sdk.CrumbtrailPendingCrashStore
import ai.crumbtrail.sdk.CrumbtrailPendingHang
import ai.crumbtrail.sdk.CrumbtrailPendingHangStore
import ai.crumbtrail.sdk.CrumbtrailProcessExit
import ai.crumbtrail.sdk.CrumbtrailProcessExitCollector
import ai.crumbtrail.sdk.CrumbtrailProcessExitMarker
import ai.crumbtrail.sdk.CrumbtrailProcessExitReader
import ai.crumbtrail.sdk.CrumbtrailExecutorWatchdogScheduler
import ai.crumbtrail.sdk.CrumbtrailMainThreadWatchdog
import ai.crumbtrail.sdk.CrumbtrailSessionStore
import ai.crumbtrail.sdk.JsonValue
import ai.crumbtrail.sdk.PersistedSession
import ai.crumbtrail.sdk.boundedDiagnosticText
import ai.crumbtrail.sdk.redactedDiagnosticText
import ai.crumbtrail.sdk.installCrashHandler
import android.app.ActivityManager
import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * `SharedPreferences`-backed session store.
 *
 * Survives an app restart, an app update, and the OS clearing the app's cache
 * directory — which the `cache` dir explicitly does not.
 */
class SharedPreferencesSessionStore(
    context: Context,
    private val key: String = "ai.crumbtrail.session",
) : CrumbtrailSessionStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("ai.crumbtrail", Context.MODE_PRIVATE)

    override fun read(): PersistedSession? {
        val raw = prefs.getString(key, null) ?: return null
        return try {
            val json = JSONObject(raw)
            val id = json.optString("id")
            // A store written by an older SDK, or corrupted on disk, must start
            // a fresh session rather than crash the host app at launch.
            if (id.isEmpty()) null
            else PersistedSession(id, json.optLong("lastActivity", 0))
        } catch (_: Exception) {
            null
        }
    }

    override fun write(session: PersistedSession) {
        val json = JSONObject()
            .put("id", session.id)
            .put("lastActivity", session.lastActivity)
        prefs.edit().putString(key, json.toString()).apply()
    }

    override fun clear() {
        prefs.edit().remove(key).apply()
    }
}

/**
 * `SharedPreferences`-backed pending crash store.
 *
 * Written with `commit()`, not `apply()`. `apply()` hands the write to a
 * background thread and returns; in an uncaught-exception handler the process
 * dies before that thread runs, so the crash report is lost exactly when it
 * matters. `commit()` writes synchronously, which is a disk write on the main
 * thread — permitted by the platform's default thread policy, unlike the
 * network call this replaces.
 */
class SharedPreferencesPendingCrashStore(
    context: Context,
    private val key: String = "ai.crumbtrail.pending-crash",
) : CrumbtrailPendingCrashStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("ai.crumbtrail", Context.MODE_PRIVATE)

    override fun write(crash: CrumbtrailPendingCrash) {
        val json = JSONObject()
            .put("message", redactedDiagnosticText(crash.message, 1_024))
            .put("stack", redactedDiagnosticText(crash.stack) ?: JSONObject.NULL)
            .put("thread", redactedDiagnosticText(crash.thread, 256) ?: JSONObject.NULL)
            .put("at", crash.at)
        prefs.edit().putString(key, json.toString()).commit()
    }

    override fun read(): CrumbtrailPendingCrash? {
        val raw = prefs.getString(key, null) ?: return null
        return try {
            val json = JSONObject(raw)
            val message = json.optString("message")
            // A record written by an older SDK, or corrupted on disk, must not
            // report a crash with no message rather than crash the host again.
            if (message.isEmpty()) null
            else CrumbtrailPendingCrash(
                message = redactedDiagnosticText(message, 1_024) ?: "uncaught exception",
                stack = redactedDiagnosticText(json.optString("stack").takeIf { it.isNotEmpty() }),
                thread = redactedDiagnosticText(json.optString("thread").takeIf { it.isNotEmpty() }, 256),
                at = json.optLong("at", 0),
            )
        } catch (_: Exception) {
            null
        }
    }

    override fun clear() {
        prefs.edit().remove(key).commit()
    }
}

/** Durable handoff for a main-thread stall that recovered or killed the app. */
class SharedPreferencesPendingHangStore(
    context: Context,
    private val key: String = "ai.crumbtrail.pending-hang",
) : CrumbtrailPendingHangStore {
    override val importIdentity: Any = "${context.applicationContext.packageName}:ai.crumbtrail:$key"
    private companion object {
        // SharedPreferences instances created by separate logger instances
        // still address the same durable slot. Keep the claim atomic in this
        // process so two watchdogs do not both report one main-thread stall.
        val handoffLock = Any()
    }

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("ai.crumbtrail", Context.MODE_PRIVATE)

    private fun encoded(hang: CrumbtrailPendingHang): String = JSONObject()
        .put("thresholdMs", hang.thresholdMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS))
        .put("observedDurationMs", hang.observedDurationMs.coerceIn(0, CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS))
        .put("stack", redactedDiagnosticText(hang.stack) ?: JSONObject.NULL)
        .put("at", hang.at)
        .put("startedAt", hang.startedAt)
        .toString()

    override fun write(hang: CrumbtrailPendingHang) {
        synchronized(handoffLock) {
            prefs.edit().putString(key, encoded(hang)).commit()
        }
    }

    override fun writeIfEmpty(hang: CrumbtrailPendingHang): Boolean = synchronized(handoffLock) {
        if (readUnlocked() != null) return@synchronized false
        prefs.edit().putString(key, encoded(hang)).commit()
    }

    override fun read(): CrumbtrailPendingHang? = synchronized(handoffLock) {
        readUnlocked()
    }

    private fun readUnlocked(): CrumbtrailPendingHang? {
        val raw = runCatching { prefs.getString(key, null) }.getOrNull() ?: return null
        return runCatching {
            val json = JSONObject(raw)
            val at = json.optLong("at", 0)
            val threshold = json.optLong("thresholdMs", 0)
            val observed = json.optLong("observedDurationMs", 0)
            if (at <= 0 || threshold < 0 || observed < 0) null
            else CrumbtrailPendingHang(
                thresholdMs = threshold.coerceAtMost(CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                observedDurationMs = observed.coerceAtMost(CrumbtrailMainThreadWatchdog.MAX_NATIVE_HANG_DURATION_MS),
                stack = if (json.isNull("stack")) null else redactedDiagnosticText(json.optString("stack").takeIf { it.isNotEmpty() }),
                at = at,
                startedAt = json.optLong("startedAt", at),
            )
        }.getOrNull()
    }

    override fun clear() {
        synchronized(handoffLock) {
            runCatching { prefs.edit().remove(key).commit() }
        }
    }

    override fun clearIfMatches(hang: CrumbtrailPendingHang): Boolean = synchronized(handoffLock) {
        if (readUnlocked() != hang) return@synchronized false
        runCatching { prefs.edit().remove(key).commit() }.getOrDefault(false)
    }
}

/** Last process-exit timestamp observed by this SDK installation. */
class SharedPreferencesProcessExitMarker(
    context: Context,
    private val key: String = "ai.crumbtrail.process-exit-at",
) : CrumbtrailProcessExitMarker {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("ai.crumbtrail", Context.MODE_PRIVATE)

    override fun read(): Long? = runCatching {
        prefs.getLong(key, 0).takeIf { it > 0 }
    }.getOrNull()

    override fun write(timestamp: Long) {
        runCatching { prefs.edit().putLong(key, timestamp).apply() }
    }
}

/** API 30+ process exit history behind a compile-only Android seam. */
class AndroidApplicationExitInfoReader(private val context: Context) : CrumbtrailProcessExitReader {
    override fun read(maxEntries: Int): List<CrumbtrailProcessExit> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || maxEntries <= 0) return emptyList()
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return emptyList()
        return runCatching {
            manager.getHistoricalProcessExitReasons(context.packageName, 0, maxEntries)
                .mapNotNull { info ->
                    val timestamp = info.timestamp
                    if (timestamp <= 0) return@mapNotNull null
                    CrumbtrailProcessExit(
                        reason = androidProcessExitReason(info.reason),
                        timestamp = timestamp,
                        importance = info.importance,
                        status = info.status,
                        description = info.description,
                    )
                }
        }.getOrDefault(emptyList())
    }

}

/** Keep expected lifecycle exits distinct from failures as Android adds reasons. */
internal fun androidProcessExitReason(reason: Int): String = when (reason) {
    android.app.ApplicationExitInfo.REASON_ANR -> "anr"
    android.app.ApplicationExitInfo.REASON_CRASH -> "crash"
    android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash"
    android.app.ApplicationExitInfo.REASON_LOW_MEMORY -> "low-memory"
    android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization-failure"
    android.app.ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission-change"
    android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive-resource-usage"
    android.app.ApplicationExitInfo.REASON_USER_REQUESTED -> "user-requested"
    android.app.ApplicationExitInfo.REASON_USER_STOPPED -> "user-stopped"
    android.app.ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency-died"
    android.app.ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package-updated"
    android.app.ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package-state-change"
    android.app.ApplicationExitInfo.REASON_FREEZER -> "freezer"
    android.app.ApplicationExitInfo.REASON_EXIT_SELF -> "exit-self"
    android.app.ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    android.app.ApplicationExitInfo.REASON_UNKNOWN -> "unknown"
    android.app.ApplicationExitInfo.REASON_OTHER -> "other"
    else -> "unknown"
}

/** Read device and app facts from the platform. */
fun readAndroidDeviceInfo(context: Context): CrumbtrailDeviceInfo {
    val app = context.applicationContext
    val packageName = app.packageName
    val packageInfo = runCatching {
        app.packageManager.getPackageInfo(packageName, 0)
    }.getOrNull()

    return CrumbtrailDeviceInfo(
        // Build.MODEL is the specific device ("Pixel 8"), which is what an
        // engineer can actually go and test on.
        model = Build.MODEL,
        manufacturer = Build.MANUFACTURER,
        os = "Android",
        osVersion = Build.VERSION.RELEASE,
        appId = packageName,
        appVersion = packageInfo?.versionName,
        appBuild = packageInfo?.let {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) it.longVersionCode.toString()
            else @Suppress("DEPRECATION") it.versionCode.toString()
        },
        locale = java.util.Locale.getDefault().toLanguageTag(),
    )
    // Deliberately absent: ANDROID_ID, the advertising id, and any hardware
    // serial. A model and OS version explain a bug; a device identifier only
    // tracks a person, and shipping one would make this SDK a privacy liability
    // in a Play Store review.
}

/**
 * Start capture for an Android app.
 *
 * Call from `Application.onCreate`. Starting there rather than in an Activity is
 * what lets the crash handler and background hang importer begin before the app
 * enters its first screen without doing a hang handoff commit on the main thread.
 */
fun startCrumbtrail(
    application: Application,
    config: CrumbtrailConfig,
): Crumbtrail {
    val logger = Crumbtrail(
        config = config,
        transport = CrumbtrailHttpTransport(config.endpoint, config.ingestKey),
        store = SharedPreferencesSessionStore(application),
        deviceInfo = readAndroidDeviceInfo(application),
    )
    if (config.collectors.errors) {
        installCrashHandler(logger, SharedPreferencesPendingCrashStore(application))
    }
    val pendingHangs = SharedPreferencesPendingHangStore(application)
    if (config.collectors.nativeDiagnostics || config.collectors.nativeWatchdog) {
        schedulePendingHangDrain(pendingHangs, logger)
    }
    if (config.collectors.nativeDiagnostics) {
        runCatching { installProcessExitCollector(application, logger) }
        runCatching { installMemoryPressureCollector(application, logger) }
    }
    val watchdog = if (config.collectors.nativeWatchdog) {
        createWatchdog(application, logger, pendingHangs)
    } else null
    if (config.collectors.needsApplicationLifecycleObserver) {
        installLifecycleCollector(
            application = application,
            logger = logger,
            watchdog = watchdog,
            captureLifecycleEvents = config.collectors.appLifecycle,
            captureNavigationEvents = config.collectors.navigation,
        )
    }
    if (watchdog != null) logger.registerCleanup { watchdog.stop() }
    return logger
}

private fun schedulePendingHangDrain(
    handoff: SharedPreferencesPendingHangStore,
    logger: Crumbtrail,
) {
    val scheduler = CrumbtrailExecutorWatchdogScheduler { }
    scheduler.postToBackground {
        runCatching {
            ai.crumbtrail.sdk.drainPendingHang(handoff) { hang -> logger.recordNativeHang(hang) }
        }
        scheduler.shutdown()
    }
    logger.registerCleanup {
        scheduler.drain()
        scheduler.shutdown()
    }
}

private fun Crumbtrail.recordNativeHang(
    hang: ai.crumbtrail.sdk.CrumbtrailNativeHang,
): Boolean = addEvent(
    CrumbtrailEventKind.NATIVE_HANG,
    JsonValue.of(
        "source" to JsonValue.Str("main-thread"),
        "thresholdMs" to JsonValue.Num(hang.thresholdMs),
        "observedDurationMs" to JsonValue.Num(hang.observedDurationMs),
        "recovered" to JsonValue.Bool(hang.recovered),
        "previousLaunch" to JsonValue.Bool(hang.previousLaunch),
        "stk" to JsonValue.str(hang.stack),
    ),
)

private fun createWatchdog(
    application: Application,
    logger: Crumbtrail,
    handoff: SharedPreferencesPendingHangStore,
): CrumbtrailMainThreadWatchdog {
    val handler = Handler(Looper.getMainLooper())
    val scheduler = CrumbtrailExecutorWatchdogScheduler { runnable -> handler.post(runnable) }
    return CrumbtrailMainThreadWatchdog(
        scheduler = scheduler,
        handoff = handoff,
        onHang = logger::recordNativeHang,
        isDebuggerAttached = { Debug.isDebuggerConnected() },
        captureStack = {
            runCatching {
                boundedDiagnosticText(
                    Looper.getMainLooper().thread.stackTrace
                        .take(ai.crumbtrail.sdk.MAX_DIAGNOSTIC_STACK_FRAMES)
                        .joinToString("\n") { it.toString() },
                )
            }.getOrNull()
        },
    )
}

private fun installProcessExitCollector(application: Application, logger: Crumbtrail) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    val scheduler = CrumbtrailExecutorWatchdogScheduler { }
    scheduler.postToBackground {
        runCatching {
            CrumbtrailProcessExitCollector(
                reader = AndroidApplicationExitInfoReader(application),
                marker = SharedPreferencesProcessExitMarker(application),
                emit = {},
                acknowledge = { exit ->
                    logger.addEvent(
                        CrumbtrailEventKind.APP_LIFECYCLE,
                        JsonValue.of(
                            "state" to JsonValue.Str("process-exit"),
                            "kind" to JsonValue.Str(exit.reason),
                            "source" to JsonValue.Str("application-exit-info"),
                            "at" to JsonValue.Num(exit.timestamp),
                            "importance" to exit.importance?.let(JsonValue::Num),
                            "status" to exit.status?.let(JsonValue::Num),
                            "description" to JsonValue.str(redactedDiagnosticText(exit.description, 1_024)),
                        ),
                    )
                },
            ).collect()
        }
        scheduler.shutdown()
    }
    logger.registerCleanup {
        scheduler.drain()
        scheduler.shutdown()
    }
}

private fun installMemoryPressureCollector(application: Application, logger: Crumbtrail) {
    @Suppress("DEPRECATION")
    val callbacks = object : ComponentCallbacks2 {
        @Suppress("DEPRECATION")
        override fun onTrimMemory(level: Int) {
            val kind = when {
                level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "moderate"
                level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "low"
                level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
                level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "ui-hidden"
                level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "critical"
                level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE -> "low"
                level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> "background"
                else -> "unknown"
            }
            logger.addEvent(
                CrumbtrailEventKind.APP_LIFECYCLE,
                JsonValue.of(
                    "state" to JsonValue.Str("memory-pressure"),
                    "kind" to JsonValue.Str(kind),
                    "source" to JsonValue.Str("component-callbacks"),
                    "level" to JsonValue.Num(level.toLong()),
                ),
            )
        }

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onLowMemory() {
            logger.addEvent(
                CrumbtrailEventKind.APP_LIFECYCLE,
                JsonValue.of(
                    "state" to JsonValue.Str("memory-pressure"),
                    "kind" to JsonValue.Str("critical"),
                    "source" to JsonValue.Str("component-callbacks"),
                ),
            )
        }

        @Suppress("DEPRECATION")
        override fun onConfigurationChanged(newConfig: android.content.res.Configuration) = Unit
    }
    application.registerComponentCallbacks(callbacks)
    logger.registerCleanup { application.unregisterComponentCallbacks(callbacks) }
}

/**
 * Foreground and background transitions, plus which screen is on top.
 *
 * Android can suspend timers, drop sockets, or kill the process while the app is
 * backgrounded. This collector separates those transitions from active hangs.
 */
fun installLifecycleCollector(application: Application, logger: Crumbtrail) {
    installLifecycleCollector(application, logger, null, true, true)
}

fun installLifecycleCollector(
    application: Application,
    logger: Crumbtrail,
    watchdog: CrumbtrailMainThreadWatchdog?,
    captureLifecycleEvents: Boolean = true,
    captureNavigationEvents: Boolean = true,
) {
    val callbacks = object : Application.ActivityLifecycleCallbacks {
        private var startedActivities = 0

        override fun onActivityStarted(activity: Activity) {
            startedActivities++
            // The first started Activity is the app entering the foreground;
            // later ones are just navigation within it.
            if (startedActivities == 1) {
                watchdog?.resume()
                if (captureLifecycleEvents) {
                    logger.addEvent(
                        CrumbtrailEventKind.APP_LIFECYCLE,
                        JsonValue.of(
                            "state" to JsonValue.Str("foreground"),
                            "source" to JsonValue.Str("activity-lifecycle"),
                        ),
                    )
                }
            }
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities = (startedActivities - 1).coerceAtLeast(0)
            if (startedActivities == 0) {
                watchdog?.pause()
                if (captureLifecycleEvents) {
                    logger.addEvent(
                        CrumbtrailEventKind.APP_LIFECYCLE,
                        JsonValue.of(
                            "state" to JsonValue.Str("background"),
                            "source" to JsonValue.Str("activity-lifecycle"),
                        ),
                    )
                }
                // The last reliable moment to deliver: Android may kill the
                // process at any point after this and never resume it.
                logger.flush()
            }
        }

        override fun onActivityResumed(activity: Activity) {
            if (captureNavigationEvents) logger.addEvent(
                CrumbtrailEventKind.NAVIGATION,
                JsonValue.of(
                    "name" to JsonValue.Str(activity.javaClass.simpleName),
                    "source" to JsonValue.Str("activity-lifecycle"),
                ),
            )
        }

        override fun onActivityCreated(activity: Activity, bundle: Bundle?) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, bundle: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    application.registerActivityLifecycleCallbacks(callbacks)
    logger.registerCleanup { application.unregisterActivityLifecycleCallbacks(callbacks) }
}
