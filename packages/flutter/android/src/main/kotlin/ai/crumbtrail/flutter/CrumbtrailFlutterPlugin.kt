package ai.crumbtrail.flutter

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Optional Android half of the Flutter diagnostics channel.
 *
 * It owns only bounded local evidence. Dart drains this channel and stamps the
 * shared Flutter event envelope, so this plugin never performs network I/O and
 * cannot turn a diagnostics failure into an application failure.
 */
class CrumbtrailFlutterPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var context: Context
    private var application: Application? = null
    private var activityCallbacks: Application.ActivityLifecycleCallbacks? = null
    private var watchdogExecutor = Executors.newSingleThreadScheduledExecutor {
        Thread(it, "crumbtrail-flutter-watchdog").apply { isDaemon = true }
    }
    private var watchdogTask: ScheduledFuture<*>? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var lastHeartbeat = System.currentTimeMillis()
    @Volatile private var watchdogPending = false
    private var previousHandler: Thread.UncaughtExceptionHandler? = null
    private var installedHandler: Thread.UncaughtExceptionHandler? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
        application = context.applicationContext as? Application
        installCrashHandler()
        installLifecycleCollector()
        collectPreviousProcessExit()
        startWatchdog()
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        activityCallbacks?.let { application?.unregisterActivityLifecycleCallbacks(it) }
        activityCallbacks = null
        watchdogTask?.cancel(true)
        watchdogTask = null
        watchdogExecutor.shutdownNow()
        if (installedHandler != null && Thread.getDefaultUncaughtExceptionHandler() === installedHandler) {
            Thread.setDefaultUncaughtExceptionHandler(previousHandler)
        }
        installedHandler = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "getCapabilities" -> result.success(capabilities())
                "drainDiagnostics" -> result.success(drainDiagnostics())
                else -> result.notImplemented()
            }
        } catch (_: Exception) {
            // The channel is an optional capture plane. An unavailable response
            // is safer than surfacing a plugin exception to Dart.
            if (call.method == "getCapabilities") result.success(absentCapabilities())
            else if (call.method == "drainDiagnostics") result.success(emptyList<Map<String, Any?>>())
            else result.notImplemented()
        }
    }

    private fun capabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(true),
        "nativeHang" to capability(true),
        "nativeCrash" to capability(true),
        "appLifecycle" to capability(true),
    )

    private fun absentCapabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(false),
        "nativeHang" to capability(false),
        "nativeCrash" to capability(false),
        "appLifecycle" to capability(false),
    )

    private fun capability(supported: Boolean): Map<String, Boolean> = mapOf(
        "supported" to supported,
        "enabled" to supported,
        "observed" to false,
    )

    private fun installCrashHandler() {
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        val handler = Thread.UncaughtExceptionHandler { thread, throwable ->
            runCatching {
                appendPending(
                    "native-crash",
                    mapOf(
                        "msg" to bounded(throwable.message ?: throwable.toString()),
                        "stk" to bounded(throwable.stackTraceToString()),
                        "source" to "previous-launch",
                        "thread" to bounded(thread.name),
                    ),
                )
            }
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

    private fun appendLifecycle(state: String) {
        appendPending(
            "app-lifecycle",
            mapOf("state" to state, "source" to "activity-lifecycle"),
        )
    }

    private fun collectPreviousProcessExit() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
        runCatching {
            val prefs = preferences()
            val lastSeen = prefs.getLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, 0L)
            var newest = lastSeen
            manager.getHistoricalProcessExitReasons(context.packageName, 0, 4)
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
                        else -> appendPending(
                            "app-lifecycle",
                            mapOf(
                                "state" to "process-exit",
                                "kind" to processExitReason(reason),
                                "source" to "application-exit-info",
                                "at" to info.timestamp,
                                "status" to info.status,
                            ),
                        )
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
        val handler = mainHandler
        watchdogTask = watchdogExecutor.scheduleAtFixedRate({
            val now = System.currentTimeMillis()
            if (now - lastHeartbeat > HANG_THRESHOLD_MS && !watchdogPending && !Debug.isDebuggerConnected()) {
                watchdogPending = true
                appendPending(
                    "native-hang",
                    mapOf(
                        "source" to "main-thread",
                        "thresholdMs" to HANG_THRESHOLD_MS,
                        "observedDurationMs" to (now - lastHeartbeat).coerceAtMost(MAX_DURATION_MS),
                        "recovered" to false,
                        "previousLaunch" to false,
                    ),
                )
            }
            runCatching { handler.post { lastHeartbeat = System.currentTimeMillis() } }
        }, CHECK_INTERVAL_MS, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun drainDiagnostics(): List<Map<String, Any?>> {
        val prefs = preferences()
        val raw = prefs.getString(PENDING_KEY, null) ?: return emptyList()
        prefs.edit().remove(PENDING_KEY).commit()
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val kind = item.optString("kind")
                val data = item.optJSONObject("data") ?: return@mapNotNull null
                mapOf("kind" to kind, "data" to jsonMap(data))
            }
        }.getOrDefault(emptyList())
    }

    private fun appendPending(kind: String, data: Map<String, Any?>) {
        runCatching {
            val prefs = preferences()
            val current = JSONArray(prefs.getString(PENDING_KEY, "[]"))
            while (current.length() >= MAX_PENDING_EVENTS) current.remove(0)
            val json = JSONObject().put("kind", kind).put("data", JSONObject(data))
            current.put(json)
            prefs.edit().putString(PENDING_KEY, current.toString()).commit()
        }
    }

    private fun preferences() = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun jsonMap(json: JSONObject): Map<String, Any?> {
        val result = mutableMapOf<String, Any?>()
        json.keys().forEach { key ->
            val value = json.opt(key)
            if (value is String || value is Boolean || value is Number) result[key] = value
        }
        return result
    }

    private fun bounded(value: String): String = value.take(MAX_TEXT)

    companion object {
        private const val CHANNEL = "ai.crumbtrail/native_diagnostics"
        private const val PREFERENCES = "ai.crumbtrail.flutter"
        private const val PENDING_KEY = "native-diagnostics"
        private const val LAST_PROCESS_EXIT_TIMESTAMP_KEY = "native-diagnostics.last-process-exit"
        private const val MAX_PENDING_EVENTS = 32
        private const val MAX_TEXT = 8_192
        private const val HANG_THRESHOLD_MS = 5_000L
        private const val CHECK_INTERVAL_MS = 1_000L
        private const val MAX_DURATION_MS = 86_400_000L
    }
}
