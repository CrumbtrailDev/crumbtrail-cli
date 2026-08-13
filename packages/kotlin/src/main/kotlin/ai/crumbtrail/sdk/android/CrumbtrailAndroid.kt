package ai.crumbtrail.sdk.android

import ai.crumbtrail.sdk.Crumbtrail
import ai.crumbtrail.sdk.CrumbtrailConfig
import ai.crumbtrail.sdk.CrumbtrailDeviceInfo
import ai.crumbtrail.sdk.CrumbtrailEventKind
import ai.crumbtrail.sdk.CrumbtrailHttpTransport
import ai.crumbtrail.sdk.CrumbtrailSessionStore
import ai.crumbtrail.sdk.JsonValue
import ai.crumbtrail.sdk.PersistedSession
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
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
    if (config.collectors.errors) installCrashHandler(logger)
    if (config.collectors.appLifecycle) installLifecycleCollector(application, logger)
    return logger
}

/**
 * Capture an uncaught exception on the way down.
 *
 * Unlike iOS, Android's default handler gives us a brief window before the
 * process dies, so this attempts a synchronous flush rather than deferring to
 * the next launch. It is best effort and explicitly time-bounded by the
 * transport's own timeouts: blocking a dying process for longer would turn a
 * crash into an ANR, which is strictly worse for the user than a lost report.
 *
 * It always chains to the previous handler. Replacing it outright would silently
 * disable whatever crash reporting the host already had.
 */
fun installCrashHandler(logger: Crumbtrail) {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
        runCatching {
            logger.addEvent(
                CrumbtrailEventKind.NATIVE_CRASH,
                JsonValue.of(
                    "msg" to JsonValue.Str(throwable.message ?: throwable.toString()),
                    "stk" to JsonValue.Str(throwable.stackTraceToString()),
                    "fatal" to JsonValue.Bool(true),
                    "thread" to JsonValue.Str(thread.name),
                    "source" to JsonValue.Str("uncaught-exception"),
                ),
            )
            logger.flush()
        }
        previous?.uncaughtException(thread, throwable)
    }
    logger.registerCleanup { Thread.setDefaultUncaughtExceptionHandler(previous) }
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
    val callbacks = object : Application.ActivityLifecycleCallbacks {
        private var startedActivities = 0

        override fun onActivityStarted(activity: Activity) {
            startedActivities++
            // The first started Activity is the app entering the foreground;
            // later ones are just navigation within it.
            if (startedActivities == 1) {
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
            startedActivities--
            if (startedActivities == 0) {
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
