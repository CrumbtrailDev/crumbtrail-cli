package ai.crumbtrail.sdk

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.random.Random

/** A session id plus when it was last active, in Unix milliseconds. */
data class PersistedSession(val id: String, val lastActivity: Long)

/** Where a session id survives between launches. */
interface CrumbtrailSessionStore {
    fun read(): PersistedSession?
    fun write(session: PersistedSession)
    fun clear()
}

/** In-memory store, for tests and for a host that opts out of persistence. */
class MemorySessionStore(private var session: PersistedSession? = null) :
    CrumbtrailSessionStore {
    override fun read(): PersistedSession? = session
    override fun write(session: PersistedSession) { this.session = session }
    override fun clear() { session = null }
}

/**
 * Decides whether to resume a persisted session or mint a new one.
 *
 * Deliberately free of Android types so the rule itself is unit-testable on the
 * JVM. The rule is subtle enough that it is the part most worth testing:
 * resuming unconditionally stitches today's bug onto last week's timeline, while
 * never resuming turns a user's week of once-a-day intermittent reports into
 * unrelated single-event sessions — which is exactly the recurrence signal the
 * product exists to surface.
 */
object CrumbtrailSessionResolver {
    fun resolve(
        store: CrumbtrailSessionStore,
        idleMs: Long,
        now: Long,
        mint: () -> String = { mintSessionId(now) },
    ): PersistedSession {
        val persisted = store.read()
        if (persisted != null && now - persisted.lastActivity <= idleMs) {
            val refreshed = persisted.copy(lastActivity = now)
            store.write(refreshed)
            return refreshed
        }
        val fresh = PersistedSession(mint(), now)
        store.write(fresh)
        return fresh
    }

    private val stamp: DateTimeFormatter =
        DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss").withZone(ZoneOffset.UTC)

    /** Same shape as the other SDKs: `ses_<date>_<time>_<random>`. */
    fun mintSessionId(now: Long = System.currentTimeMillis()): String {
        val date = stamp.format(Instant.ofEpochMilli(now))
        val random = (1..12).map { "0123456789abcdef"[Random.nextInt(16)] }.joinToString("")
        return "ses_${date}_$random"
    }
}
