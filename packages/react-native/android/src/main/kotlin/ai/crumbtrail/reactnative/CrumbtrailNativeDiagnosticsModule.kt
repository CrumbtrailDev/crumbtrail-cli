package ai.crumbtrail.reactnative

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Optional native diagnostics module for React Native. It only owns bounded
 * local handoff. JavaScript drains the records and sends them through the
 * normal Crumbtrail session, so native code has no network failure path.
 */
class CrumbtrailNativeDiagnosticsModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val application = reactContext.applicationContext as? Application
    private val preferences = reactContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadScheduledExecutor {
        Thread(it, "crumbtrail-react-native-watchdog").apply { isDaemon = true }
    }
    private var watchdogTask: ScheduledFuture<*>? = null
    @Volatile private var lastHeartbeat = System.currentTimeMillis()
    @Volatile private var watchdogPending = false
    private var previousHandler: Thread.UncaughtExceptionHandler? = null
    private var installedHandler: Thread.UncaughtExceptionHandler? = null
    private var activityCallbacks: Application.ActivityLifecycleCallbacks? = null

    init {
        installCrashHandler()
        installLifecycleCollector()
        collectPreviousProcessExit()
        startWatchdog()
    }

    override fun getName(): String = MODULE_NAME

    @ReactMethod
    fun getCapabilities(promise: Promise) {
        promise.resolve(capabilities())
    }

    @ReactMethod
    fun drainDiagnostics(promise: Promise) {
        try {
            val raw = preferences.getString(PENDING_KEY, null) ?: run {
                promise.resolve(Arguments.createArray())
                return
            }
            preferences.edit().remove(PENDING_KEY).commit()
            val output = Arguments.createArray()
            val events = JSONArray(raw)
            for (index in 0 until events.length()) {
                val item = events.optJSONObject(index) ?: continue
                val data = item.optJSONObject("data") ?: continue
                val map = Arguments.createMap()
                map.putString("kind", item.optString("kind"))
                val dataMap = Arguments.createMap()
                data.keys().forEach { key ->
                    val value = data.opt(key)
                    when (value) {
                        is String -> dataMap.putString(key, value)
                        is Boolean -> dataMap.putBoolean(key, value)
                        is Int -> dataMap.putInt(key, value)
                        is Long -> dataMap.putDouble(key, value.toDouble())
                        is Double -> dataMap.putDouble(key, value)
                        is Float -> dataMap.putDouble(key, value.toDouble())
                    }
                }
                map.putMap("data", dataMap)
                output.pushMap(map)
            }
            promise.resolve(output)
        } catch (_: Exception) {
            promise.resolve(Arguments.createArray())
        }
    }

    private fun capabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(),
        "nativeHang" to capability(),
        "nativeCrash" to capability(),
        "appLifecycle" to capability(),
    )

    private fun capability(): Map<String, Boolean> = mapOf(
        "supported" to true,
        "enabled" to true,
        "observed" to false,
    )

    private fun installCrashHandler() {
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        val handler = Thread.UncaughtExceptionHandler { thread, throwable ->
            appendPending("native-crash", mapOf(
                "msg" to bounded(throwable.message ?: throwable.toString()),
                "stk" to bounded(throwable.stackTraceToString()),
                "source" to "previous-launch",
                "thread" to bounded(thread.name),
            ))
            previousHandler?.uncaughtException(thread, throwable)
        }
        installedHandler = handler
        Thread.setDefaultUncaughtExceptionHandler(handler)
    }

    private fun installLifecycleCollector() {
        val app = application ?: return
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) = appendLifecycle("resumed")
            override fun onActivityPaused(activity: Activity) = appendLifecycle("paused")
            override fun onActivityStarted(activity: Activity) = appendLifecycle("foreground")
            override fun onActivityStopped(activity: Activity) = appendLifecycle("background")
            override fun onActivityCreated(activity: Activity, state: android.os.Bundle?) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: android.os.Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }
        activityCallbacks = callbacks
        app.registerActivityLifecycleCallbacks(callbacks)
    }

    private fun appendLifecycle(state: String) = appendPending(
        "app-lifecycle",
        mapOf("state" to state, "source" to "activity-lifecycle"),
    )

    private fun collectPreviousProcessExit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val manager = reactContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
        runCatching {
            val prefs = preferences
            val lastSeen = prefs.getLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, 0L)
            var newest = lastSeen
            manager.getHistoricalProcessExitReasons(reactContext.packageName, 0, 4)
                .filter { it.timestamp > lastSeen }
                .forEach { info ->
                    newest = maxOf(newest, info.timestamp)
                    val reason = info.reason
                    when (reason) {
                        android.app.ApplicationExitInfo.REASON_ANR -> appendPending(
                            "native-hang",
                            mapOf(
                                "source" to "main-thread",
                                "thresholdMs" to HANG_THRESHOLD_MS,
                                "observedDurationMs" to HANG_THRESHOLD_MS,
                                "recovered" to false,
                                "previousLaunch" to true,
                                "at" to info.timestamp,
                                "status" to info.status,
                            ),
                        )
                        android.app.ApplicationExitInfo.REASON_CRASH,
                        android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> appendPending(
                            "native-crash",
                            mapOf(
                                "msg" to "previous process exited: ${processExitReason(reason)}",
                                "signal" to processExitReason(reason),
                                "source" to "previous-launch",
                                "at" to info.timestamp,
                                "status" to info.status,
                            ),
                        )
                        else -> appendPending("app-lifecycle", mapOf(
                            "state" to "process-exit",
                            "kind" to processExitReason(reason),
                            "source" to "application-exit-info",
                            "at" to info.timestamp,
                            "status" to info.status,
                        ))
                    }
                }
            if (newest > lastSeen) {
                prefs.edit().putLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, newest).commit()
            }
        }
    }

    private fun processExitReason(reason: Int): String = when (reason) {
        android.app.ApplicationExitInfo.REASON_ANR -> "anr"
        android.app.ApplicationExitInfo.REASON_CRASH -> "crash"
        android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash"
        android.app.ApplicationExitInfo.REASON_LOW_MEMORY -> "low-memory"
        android.app.ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization-failure"
        android.app.ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive-resource-usage"
        android.app.ApplicationExitInfo.REASON_USER_REQUESTED -> "user-requested"
        android.app.ApplicationExitInfo.REASON_USER_STOPPED -> "user-stopped"
        else -> "other"
    }

    private fun startWatchdog() {
        watchdogTask = executor.scheduleAtFixedRate({
            val now = System.currentTimeMillis()
            if (now - lastHeartbeat > HANG_THRESHOLD_MS &&
                !watchdogPending &&
                !Debug.isDebuggerConnected()
            ) {
                watchdogPending = true
                appendPending("native-hang", mapOf(
                    "source" to "main-thread",
                    "thresholdMs" to HANG_THRESHOLD_MS,
                    "observedDurationMs" to (now - lastHeartbeat).coerceAtMost(MAX_DURATION_MS),
                    "recovered" to false,
                    "previousLaunch" to false,
                ))
            }
            runCatching { mainHandler.post { lastHeartbeat = System.currentTimeMillis() } }
        }, CHECK_INTERVAL_MS, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun appendPending(kind: String, data: Map<String, Any?>) {
        runCatching {
            val current = JSONArray(preferences.getString(PENDING_KEY, "[]"))
            while (current.length() >= MAX_PENDING_EVENTS) current.remove(0)
            current.put(JSONObject().put("kind", kind).put("data", JSONObject(data)))
            preferences.edit().putString(PENDING_KEY, current.toString()).commit()
        }
    }

    private fun bounded(value: String): String = value.take(MAX_TEXT)

    override fun onCatalystInstanceDestroy() {
        watchdogTask?.cancel(true)
        executor.shutdownNow()
        activityCallbacks?.let { application?.unregisterActivityLifecycleCallbacks(it) }
        activityCallbacks = null
        if (installedHandler != null && Thread.getDefaultUncaughtExceptionHandler() === installedHandler) {
            Thread.setDefaultUncaughtExceptionHandler(previousHandler)
        }
        installedHandler = null
        super.onCatalystInstanceDestroy()
    }

    companion object {
        const val MODULE_NAME = "CrumbtrailNativeDiagnostics"
        private const val PREFERENCES = "ai.crumbtrail.react-native"
        private const val PENDING_KEY = "native-diagnostics"
        private const val LAST_PROCESS_EXIT_TIMESTAMP_KEY = "native-diagnostics.last-process-exit"
        private const val MAX_PENDING_EVENTS = 32
        private const val MAX_TEXT = 8_192
        private const val HANG_THRESHOLD_MS = 5_000L
        private const val CHECK_INTERVAL_MS = 1_000L
        private const val MAX_DURATION_MS = 86_400_000L
    }
}
