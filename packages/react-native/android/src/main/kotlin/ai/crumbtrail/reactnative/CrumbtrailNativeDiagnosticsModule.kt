package ai.crumbtrail.reactnative

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import java.util.Collections
import java.util.UUID
import java.util.WeakHashMap

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
    @Volatile private var lastHeartbeat = SystemClock.elapsedRealtime()
    @Volatile private var watchdogPending = false
    @Volatile private var enabled = false
    private var collectorsStarted = false
    private var activityCallbacks: Application.ActivityLifecycleCallbacks? = null

    override fun getName(): String = MODULE_NAME

    @ReactMethod
    fun getCapabilities(promise: Promise) {
        promise.resolve(capabilities())
    }

    @ReactMethod
    fun setEnabled(value: Boolean) {
        if (value) startCollectors() else stopCollectors()
    }

    @ReactMethod
    fun drainDiagnostics(promise: Promise) {
        try {
            promise.resolve(drainPending())
        } catch (_: Exception) {
            promise.resolve(emptyDrain())
        }
    }

    @ReactMethod
    fun acknowledgeDiagnostics(token: String, promise: Promise) {
        promise.resolve(acknowledgePending(token))
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

    private fun drainPending(): Map<String, Any> = synchronized(PENDING_LOCK) {
        if (!enabled) return@synchronized emptyDrain()
        val existingToken = inFlightToken
        val existingItems = inFlightItems
        if (existingToken != null && existingItems != null) {
            return@synchronized drainResponse(existingToken, existingItems)
        }
        val raw = pendingRetryValue ?: preferences.getString(PENDING_KEY, null)
            ?: return@synchronized emptyDrain()
        val items = parsePending(raw) ?: return@synchronized emptyDrain()
        if (items.isEmpty()) return@synchronized emptyDrain()
        val token = UUID.randomUUID().toString()
        val serialized = items.map { it.toString() }
        inFlightToken = token
        inFlightItems = serialized
        drainResponse(token, serialized)
    }

    private fun acknowledgePending(token: String): Boolean = synchronized(PENDING_LOCK) {
        if (token.isEmpty() || token != inFlightToken) return@synchronized false
        val snapshot = inFlightItems ?: return@synchronized false
        val raw = pendingRetryValue ?: preferences.getString(PENDING_KEY, null)
            ?: return@synchronized false
        val current = parsePending(raw) ?: return@synchronized false
        if (current.size < snapshot.size ||
            current.take(snapshot.size).map { it.toString() } != snapshot
        ) return@synchronized false

        val remaining = JSONArray()
        current.drop(snapshot.size).forEach { remaining.put(it) }
        repeat(MAX_COMMIT_ATTEMPTS) {
            val committed = runCatching {
                if (remaining.length() == 0) {
                    preferences.edit().remove(PENDING_KEY).commit()
                } else {
                    preferences.edit().putString(PENDING_KEY, remaining.toString()).commit()
                }
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

    private fun drainResponse(token: String, items: List<String>): Map<String, Any> {
        val output = Arguments.createArray()
        items.forEach { raw ->
            val item = JSONObject(raw)
            val data = item.getJSONObject("data")
            val map = Arguments.createMap()
            map.putString("kind", item.getString("kind"))
            val dataMap = Arguments.createMap()
            data.keys().forEach { key ->
                when (val value = data.opt(key)) {
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
        return mapOf("token" to token, "events" to output)
    }

    private fun emptyDrain(): Map<String, Any> = mapOf(
        "token" to "",
        "events" to Arguments.createArray(),
    )

    private fun capabilities(): Map<String, Any> = mapOf(
        "nativeDiagnostics" to capability(),
        "nativeHang" to capability(),
        "nativeCrash" to capability(),
        "appLifecycle" to capability(),
    )

    private fun capability(): Map<String, Boolean> = mapOf(
        "supported" to true,
        "enabled" to enabled,
        "observed" to false,
    )

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
        appendPending("native-crash", mapOf(
            "msg" to bounded(throwable.message ?: throwable.toString()),
            "stk" to bounded(throwable.stackTraceToString()),
            "source" to "previous-launch",
            "thread" to bounded(thread.name),
        ))
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
            synchronized(PENDING_LOCK) {
                if (!enabled) return@synchronized
                val lastSeen = preferences.getLong(LAST_PROCESS_EXIT_TIMESTAMP_KEY, 0L)
                var newest = lastSeen
                val pending = JSONArray(
                    pendingRetryValue ?: preferences.getString(PENDING_KEY, "[]"),
                )
                val exits = manager.getHistoricalProcessExitReasons(
                    reactContext.packageName,
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
                    val committed = commitProcessExit(pending.toString(), newest)
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
        watchdogTask = executor.scheduleAtFixedRate({
            val now = SystemClock.elapsedRealtime()
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
            runCatching { mainHandler.post { lastHeartbeat = SystemClock.elapsedRealtime() } }
        }, CHECK_INTERVAL_MS, CHECK_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun appendPending(kind: String, data: Map<String, Any?>) {
        runCatching {
            synchronized(PENDING_LOCK) {
                if (!enabled) return@synchronized
                val current = JSONArray(pendingRetryValue ?: preferences.getString(PENDING_KEY, "[]"))
                while (current.length() >= MAX_PENDING_EVENTS) current.remove(0)
                current.put(JSONObject().put("kind", kind).put("data", JSONObject(data)))
                commitPending(current.toString())
            }
        }
    }

    private fun commitPending(value: String): Boolean {
        repeat(MAX_COMMIT_ATTEMPTS) {
            if (runCatching { preferences.edit().putString(PENDING_KEY, value).commit() }
                    .getOrDefault(false)) {
                pendingRetryValue = null
                return true
            }
        }
        pendingRetryValue = value
        return false
    }

    private fun commitProcessExit(value: String, timestamp: Long): Boolean {
        repeat(MAX_COMMIT_ATTEMPTS) {
            if (runCatching {
                    preferences.edit()
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

    private fun bounded(value: String): String = value.take(MAX_TEXT)

    override fun onCatalystInstanceDestroy() {
        stopCollectors()
        executor.shutdownNow()
        super.onCatalystInstanceDestroy()
    }

    companion object {
        const val MODULE_NAME = "CrumbtrailNativeDiagnostics"
        private val PENDING_LOCK = Any()
        private val ACTIVE_MODULES = Collections.newSetFromMap(
            WeakHashMap<CrumbtrailNativeDiagnosticsModule, Boolean>(),
        )
        private var previousProcessHandler: Thread.UncaughtExceptionHandler? = null
        private val SHARED_EXCEPTION_HANDLER = Thread.UncaughtExceptionHandler { thread, throwable ->
            val modules: List<CrumbtrailNativeDiagnosticsModule>
            val previous: Thread.UncaughtExceptionHandler?
            synchronized(PENDING_LOCK) {
                modules = ACTIVE_MODULES.toList()
                previous = previousProcessHandler
            }
            modules.firstOrNull()?.recordUncaughtException(thread, throwable)
            previous?.uncaughtException(thread, throwable)
        }
        private var inFlightToken: String? = null
        private var inFlightItems: List<String>? = null
        private var pendingRetryValue: String? = null
        private const val MAX_COMMIT_ATTEMPTS = 3
        private const val PREFERENCES = "ai.crumbtrail.react-native"
        private const val PENDING_KEY = "native-diagnostics"
        private const val LAST_PROCESS_EXIT_TIMESTAMP_KEY = "native-diagnostics.last-process-exit"
        private const val MAX_PENDING_EVENTS = 32
        private const val MAX_TEXT = 8_192
        private const val HANG_THRESHOLD_MS = 5_000L
        private const val CHECK_INTERVAL_MS = 1_000L
        private const val MAX_DURATION_MS = 86_400_000L
        private const val MAX_PROCESS_EXIT_ENTRIES = 8
    }
}
