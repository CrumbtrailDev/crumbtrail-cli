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
import ai.crumbtrail.sdk.boundedStackTrace
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
            .put("message", crash.message)
            .put("stack", crash.stack ?: JSONObject.NULL)
            .put("thread", crash.thread ?: JSONObject.NULL)
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
                message = message,
                stack = json.optString("stack").takeIf { it.isNotEmpty() },
                thread = json.optString("thread").takeIf { it.isNotEmpty() },
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
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("ai.crumbtrail", Context.MODE_PRIVATE)

    override fun write(hang: CrumbtrailPendingHang) {
        val json = JSONObject()
            .put("thresholdMs", hang.thresholdMs)
            .put("observedDurationMs", hang.observedDurationMs)
            .put("stack", hang.stack ?: JSONObject.NULL)
            .put("at", hang.at)
            .put("startedAt", hang.startedAt)
        // A watchdog write is not allowed to block indefinitely. `commit` is a
        // bounded handoff on the main thread only indirectly, and the writer
        // itself always runs on the watchdog thread.
        runCatching { prefs.edit().putString(key, json.toString()).commit() }
    }

    override fun read(): CrumbtrailPendingHang? {
        val raw = runCatching { prefs.getString(key, null) }.getOrNull() ?: return null
        return runCatching {
            val json = JSONObject(raw)
            val at = json.optLong("at", 0)
            val threshold = json.optLong("thresholdMs", 0)
            val observed = json.optLong("observedDurationMs", 0)
            if (at <= 0 || threshold < 0 || observed < 0) null
            else CrumbtrailPendingHang(
                thresholdMs = threshold,
                observedDurationMs = observed,
                stack = boundedDiagnosticText(json.optString("stack").takeIf { it.isNotEmpty() }),
                at = at,
                startedAt = json.optLong("startedAt", at),
            )
        }.getOrNull()
    }

    override fun clear() { runCatching { prefs.edit().remove(key).commit() } }
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
                        reason = processExitReason(info.reason),
                        timestamp = timestamp,
                        importance = info.importance,
                        status = info.status,
                        description = info.description,
                    )
                }
        }.getOrDefault(emptyList())
    }

    private fun processExitReason(reason: Int): String = when (reason) {
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
        android.app.ApplicationExitInfo.REASON_OTHER -> "other"
        else -> "unknown"
    }
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
 * what lets the crash handler pick up a crash from the previous launch before
 * anything else has a chance to fail.
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
    if (config.collectors.nativeDiagnostics) {
        runCatching { drainPendingHang(pendingHangs, logger) }
        runCatching { installProcessExitCollector(application, logger) }
        runCatching { installMemoryPressureCollector(application, logger) }
    }
    val watchdog = if (config.collectors.nativeWatchdog && config.collectors.appLifecycle) {
        createWatchdog(application, logger, pendingHangs)
    } else null
    if (config.collectors.appLifecycle) installLifecycleCollector(application, logger, watchdog)
    if (watchdog != null) logger.registerCleanup { watchdog.stop() }
    return logger
}

private fun drainPendingHang(
    handoff: SharedPreferencesPendingHangStore,
    logger: Crumbtrail,
) {
    ai.crumbtrail.sdk.drainPendingHang(handoff) { hang -> logger.recordNativeHang(hang) }
}

private fun Crumbtrail.recordNativeHang(hang: ai.crumbtrail.sdk.CrumbtrailNativeHang) {
    addEvent(
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
}

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
    CrumbtrailProcessExitCollector(
        reader = AndroidApplicationExitInfoReader(application),
        marker = SharedPreferencesProcessExitMarker(application),
        emit = { exit ->
            logger.addEvent(
                CrumbtrailEventKind.APP_LIFECYCLE,
                JsonValue.of(
                    "state" to JsonValue.Str("process-exit"),
                    "kind" to JsonValue.Str(exit.reason),
                    "source" to JsonValue.Str("application-exit-info"),
                    "at" to JsonValue.Num(exit.timestamp),
                    "importance" to exit.importance?.let(JsonValue::Num),
                    "status" to exit.status?.let(JsonValue::Num),
                    "description" to JsonValue.str(exit.description),
                ),
            )
        },
    ).collect()
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
 * Load-bearing on a phone in a way it never is on desktop web: the OS suspends
 * timers, drops sockets, and may kill the process. A request that "hung" is
 * usually a request whose app was backgrounded mid-flight, and only this track
 * separates the two.
 */
fun installLifecycleCollector(application: Application, logger: Crumbtrail) {
    installLifecycleCollector(application, logger, null)
}

fun installLifecycleCollector(
    application: Application,
    logger: Crumbtrail,
    watchdog: CrumbtrailMainThreadWatchdog?,
) {
    val callbacks = object : Application.ActivityLifecycleCallbacks {
        private var startedActivities = 0

        override fun onActivityStarted(activity: Activity) {
            startedActivities++
            // The first started Activity is the app entering the foreground;
            // later ones are just navigation within it.
            if (startedActivities == 1) {
                watchdog?.resume()
                logger.addEvent(
                    CrumbtrailEventKind.APP_LIFECYCLE,
                    JsonValue.of(
                        "state" to JsonValue.Str("foreground"),
                        "source" to JsonValue.Str("activity-lifecycle"),
                    ),
                )
            }
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities = (startedActivities - 1).coerceAtLeast(0)
            if (startedActivities == 0) {
                watchdog?.pause()
                logger.addEvent(
                    CrumbtrailEventKind.APP_LIFECYCLE,
                    JsonValue.of(
                        "state" to JsonValue.Str("background"),
                        "source" to JsonValue.Str("activity-lifecycle"),
                    ),
                )
                // The last reliable moment to deliver: Android may kill the
                // process at any point after this and never resume it.
                logger.flush()
            }
        }

        override fun onActivityResumed(activity: Activity) {
            logger.addEvent(
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
