package ai.crumbtrail.flutter

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.Collections
import java.util.UUID
import java.util.WeakHashMap

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
    private var watchdogExecutor = newWatchdogExecutor()
    private var watchdogTask: ScheduledFuture<*>? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var lastHeartbeat = SystemClock.elapsedRealtime()
    @Volatile private var watchdogPending = false
    @Volatile private var enabled = false
    private var collectorsStarted = false

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL)
        channel.setMethodCallHandler(this)
        application = context.applicationContext as? Application
        if (watchdogExecutor.isShutdown) watchdogExecutor = newWatchdogExecutor()
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
        stopCollectors()
        watchdogExecutor.shutdownNow()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "getCapabilities" -> result.success(capabilities())
                "setEnabled" -> {
                    setEnabled(call.arguments as? Boolean == true)
                    result.success(null)
                }
                "drainDiagnostics" -> result.success(drainDiagnostics())
                "acknowledgeDiagnostics" ->
                    result.success(acknowledgeDiagnostics(call.arguments as? String ?: ""))
                else -> result.notImplemented()
            }
        } catch (_: Exception) {
            // The channel is an optional capture plane. An unavailable response
            // is safer than surfacing a plugin exception to Dart.
            if (call.method == "getCapabilities") result.success(absentCapabilities())
            else if (call.method == "drainDiagnostics") result.success(emptyDrain())
            else result.notImplemented()
        }
    }

    private fun capabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(),
        "nativeHang" to capability(),
        "nativeCrash" to capability(),
        "appLifecycle" to capability(),
    )

    private fun absentCapabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(false),
        "nativeHang" to capability(false),
        "nativeCrash" to capability(false),
        "appLifecycle" to capability(false),
    )

    private fun capability(supported: Boolean = true): Map<String, Boolean> = mapOf(
        "supported" to supported,
        "enabled" to (supported && enabled),
        "observed" to false,
    )

    private fun setEnabled(value: Boolean) {
        if (value) startCollectors() else stopCollectors()
    }

    private fun startCollectors() {
        synchronized(PENDING_LOCK) {
            if (collectorsStarted) return
            enabled = true
            collectorsStarted = true
        }
        registerCrashHandler()
        installLifecycleCollector()
        collectPreviousProcessExit()
        startWatchdog()
    }

    private fun stopCollectors() {
        enabled = false
        watchdogTask?.cancel(true)
        watchdogTask = null
        activityCallbacks?.let { application?.unregisterActivityLifecycleCallbacks(it) }
        activityCallbacks = null
        synchronized(PENDING_LOCK) {
            ACTIVE_MODULES.remove(this)
            if (ACTIVE_MODULES.isEmpty() &&
                Thread.getDefaultUncaughtExceptionHandler() === SHARED_EXCEPTION_HANDLER
            ) {
                Thread.setDefaultUncaughtExceptionHandler(previousProcessHandler)
            }
            if (ACTIVE_MODULES.isEmpty()) previousProcessHandler = null
            collectorsStarted = false
            watchdogPending = false
        }
    }

    private fun registerCrashHandler() {
        synchronized(PENDING_LOCK) {
            ACTIVE_MODULES.add(this)
            val current = Thread.getDefaultUncaughtExceptionHandler()
            if (current !== SHARED_EXCEPTION_HANDLER) {
                previousProcessHandler = current
                Thread.setDefaultUncaughtExceptionHandler(SHARED_EXCEPTION_HANDLER)
            }
        }
    }

    private fun recordUncaughtException(thread: Thread, throwable: Throwable) {
        if (!enabled) return
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
            synchronized(PENDING_LOCK) {
                if (!enabled) return@synchronized
                val prefs = preferences()
                val lastSeen = prefs.getLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, 0L)
                var newest = lastSeen
                val pending = JSONArray(
                    pendingRetryValue ?: prefs.getString(PENDING_KEY, "[]"),
                )
                val exits = manager.getHistoricalProcessExitReasons(
                    context.packageName,
                    0,
                    MAX_PROCESS_EXIT_ENTRIES,
                )
                    .filter { it.timestamp > lastSeen }
                    .sortedWith(compareBy(
                        { it.timestamp },
                        { it.reason },
                        { it.importance },
                        { it.status },
                        { it.description ?: "" },
                    ))
                    .take(MAX_PROCESS_EXIT_ENTRIES)
                exits.forEach { info ->
                    newest = maxOf(newest, info.timestamp)
                    appendProcessExit(pending, info)
                }
                if (newest > lastSeen) {
                    val committed = commitProcessExit(prefs, pending.toString(), newest)
                    if (!committed) return@synchronized
                }
            }
        }
    }

    private fun appendProcessExit(
        pending: JSONArray,
        info: android.app.ApplicationExitInfo,
    ) {
        val reason = info.reason
        val (kind, data) = when (reason) {
            android.app.ApplicationExitInfo.REASON_ANR -> "native-hang" to mapOf(
                "source" to "main-thread",
                "thresholdMs" to HANG_THRESHOLD_MS,
                "observedDurationMs" to HANG_THRESHOLD_MS,
                "recovered" to false,
                "previousLaunch" to true,
                "at" to info.timestamp,
                "status" to info.status,
            )
            android.app.ApplicationExitInfo.REASON_CRASH,
            android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash" to mapOf(
                "msg" to "previous process exited: ${processExitReason(reason)}",
                "signal" to processExitReason(reason),
                "source" to "previous-launch",
                "at" to info.timestamp,
                "status" to info.status,
            )
            else -> "app-lifecycle" to mapOf(
                "state" to "process-exit",
                "kind" to processExitReason(reason),
                "source" to "application-exit-info",
                "at" to info.timestamp,
                "status" to info.status,
            )
        }
        while (pending.length() >= MAX_PENDING_EVENTS) pending.remove(0)
        pending.put(JSONObject().put("kind", kind).put("data", JSONObject(data)))
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
            val now = SystemClock.elapsedRealtime()
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
            runCatching { handler.post { lastHeartbeat = SystemClock.elapsedRealtime() } }
        }, CHECK_INTERVAL_MS, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun drainDiagnostics(): Map<String, Any> = synchronized(PENDING_LOCK) {
        if (!enabled) return@synchronized emptyDrain()
        val existingToken = inFlightToken
        val existingItems = inFlightItems
        if (existingToken != null && existingItems != null) {
            return@synchronized drainResponse(existingToken, existingItems)
        }
        val prefs = preferences()
        val raw = pendingRetryValue ?: prefs.getString(PENDING_KEY, null)
            ?: return@synchronized emptyDrain()
        val items = parsePending(raw) ?: return@synchronized emptyDrain()
        if (items.isEmpty()) return@synchronized emptyDrain()
        val token = UUID.randomUUID().toString()
        val serialized = items.map { it.toString() }
        inFlightToken = token
        inFlightItems = serialized
        drainResponse(token, serialized)
    }

    private fun acknowledgeDiagnostics(token: String): Boolean = synchronized(PENDING_LOCK) {
        if (token.isEmpty() || token != inFlightToken) return@synchronized false
        val snapshot = inFlightItems ?: return@synchronized false
        val prefs = preferences()
        val raw = pendingRetryValue ?: prefs.getString(PENDING_KEY, null)
            ?: return@synchronized false
        val current = parsePending(raw) ?: return@synchronized false
        if (current.size < snapshot.size ||
            current.take(snapshot.size).map { it.toString() } != snapshot
        ) return@synchronized false

        val remaining = JSONArray()
        current.drop(snapshot.size).forEach { remaining.put(it) }
        repeat(MAX_COMMIT_ATTEMPTS) {
            val committed = runCatching {
                if (remaining.length() == 0) prefs.edit().remove(PENDING_KEY).commit()
                else prefs.edit().putString(PENDING_KEY, remaining.toString()).commit()
            }.getOrDefault(false)
            if (committed) {
                pendingRetryValue = null
                inFlightToken = null
                inFlightItems = null
                return@synchronized true
            }
        }
        pendingRetryValue = raw
        false
    }

    private fun parsePending(raw: String): List<JSONObject>? = runCatching {
        val events = JSONArray(raw)
        (0 until events.length()).map { index ->
            val item = events.optJSONObject(index) ?: error("invalid diagnostic event")
            if (item.optString("kind").isEmpty() || item.optJSONObject("data") == null) {
                error("invalid diagnostic event")
            }
            item
        }
    }.getOrNull()

    private fun drainResponse(token: String, items: List<String>): Map<String, Any> = mapOf(
        "token" to token,
        "events" to items.map { raw ->
            val item = JSONObject(raw)
            mapOf("kind" to item.getString("kind"), "data" to jsonMap(item.getJSONObject("data")))
        },
    )

    private fun emptyDrain(): Map<String, Any> = mapOf("token" to "", "events" to emptyList<Map<String, Any?>>())

    private fun appendPending(kind: String, data: Map<String, Any?>) {
        runCatching {
            synchronized(PENDING_LOCK) {
                if (!enabled) return@synchronized
                val prefs = preferences()
                val current = JSONArray(pendingRetryValue ?: prefs.getString(PENDING_KEY, "[]"))
                while (current.length() >= MAX_PENDING_EVENTS) current.remove(0)
                val json = JSONObject().put("kind", kind).put("data", JSONObject(data))
                current.put(json)
                commitPending(prefs, current.toString())
            }
        }
    }

    private fun commitPending(prefs: android.content.SharedPreferences, value: String): Boolean {
        repeat(MAX_COMMIT_ATTEMPTS) {
            if (runCatching { prefs.edit().putString(PENDING_KEY, value).commit() }
                    .getOrDefault(false)) {
                pendingRetryValue = null
                return true
            }
        }
        pendingRetryValue = value
        return false
    }

    private fun commitProcessExit(
        prefs: android.content.SharedPreferences,
        value: String,
        timestamp: Long,
    ): Boolean {
        repeat(MAX_COMMIT_ATTEMPTS) {
            if (runCatching {
                    prefs.edit()
                        .putString(PENDING_KEY, value)
                        .putLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, timestamp)
                        .commit()
                }.getOrDefault(false)) {
                pendingRetryValue = null
                return true
            }
        }
        pendingRetryValue = value
        return false
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
        private fun newWatchdogExecutor() = Executors.newSingleThreadScheduledExecutor {
            Thread(it, "crumbtrail-flutter-watchdog").apply { isDaemon = true }
        }

        private val PENDING_LOCK = Any()
        private val ACTIVE_MODULES = Collections.newSetFromMap(
            WeakHashMap<CrumbtrailFlutterPlugin, Boolean>(),
        )
        private var previousProcessHandler: Thread.UncaughtExceptionHandler? = null
        private val SHARED_EXCEPTION_HANDLER = Thread.UncaughtExceptionHandler { thread, throwable ->
            val modules: List<CrumbtrailFlutterPlugin>
            val previous: Thread.UncaughtExceptionHandler?
            synchronized(PENDING_LOCK) {
                modules = ACTIVE_MODULES.toList()
                previous = previousProcessHandler
            }
            modules.firstOrNull()?.recordUncaughtException(thread, throwable)
            previous?.uncaughtException(thread, throwable)
        }
        private const val MAX_COMMIT_ATTEMPTS = 3
        private const val CHANNEL = "ai.crumbtrail/native_diagnostics"
        private const val PREFERENCES = "ai.crumbtrail.flutter"
        private const val PENDING_KEY = "native-diagnostics"
        private const val LAST_PROCESS_EXIT_TIMESTAMP_KEY = "native-diagnostics.last-process-exit"
        private const val MAX_PENDING_EVENTS = 32
        private const val MAX_TEXT = 8_192
        private const val HANG_THRESHOLD_MS = 5_000L
        private const val CHECK_INTERVAL_MS = 1_000L
        private const val MAX_DURATION_MS = 86_400_000L
        private const val MAX_PROCESS_EXIT_ENTRIES = 8
        private var inFlightToken: String? = null
        private var inFlightItems: List<String>? = null
        private var pendingRetryValue: String? = null
    }
}
