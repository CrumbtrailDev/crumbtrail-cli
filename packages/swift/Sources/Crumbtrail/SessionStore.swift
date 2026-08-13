import Foundation

/// A session id plus the moment it was last active, both in the same unit as an
/// event timestamp (Unix milliseconds).
public struct PersistedSession: Codable, Equatable, Sendable {
    public var id: String
    public var lastActivity: Int64

    public init(id: String, lastActivity: Int64) {
        self.id = id
        self.lastActivity = lastActivity
    }
}

/// Where a session id survives between launches.
public protocol CrumbtrailSessionStore: AnyObject {
    func read() -> PersistedSession?
    func write(_ session: PersistedSession)
    func clear()
}

/// `UserDefaults`-backed store: survives an app restart, an app update, and the
/// OS reclaiming caches.
public final class UserDefaultsSessionStore: CrumbtrailSessionStore {
    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "ai.crumbtrail.session"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func read() -> PersistedSession? {
        guard let data = defaults.data(forKey: key) else { return nil }
        // A store written by an older SDK, or corrupted on disk, must start a
        // fresh session rather than crash the host app at launch.
        guard let session = try? JSONDecoder().decode(PersistedSession.self, from: data)
        else { return nil }
        return session.id.isEmpty ? nil : session
    }

    public func write(_ session: PersistedSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        defaults.set(data, forKey: key)
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}

/// Purely in-memory store, for tests and for a host that opts out of persistence.
public final class MemorySessionStore: CrumbtrailSessionStore {
    private var session: PersistedSession?

    public init(session: PersistedSession? = nil) {
        self.session = session
    }

    public func read() -> PersistedSession? { session }
    public func write(_ session: PersistedSession) { self.session = session }
    public func clear() { session = nil }
}

/// Decides whether to resume a persisted session or mint a new one.
public enum CrumbtrailSessionResolver {
    /// Resume only while the persisted session is still fresh.
    ///
    /// Both directions matter and both are wrong on their own. Resuming
    /// unconditionally stitches today's bug onto last week's timeline. Never
    /// resuming turns a user's week of once-a-day intermittent reports into a
    /// pile of unrelated single-event sessions, which is precisely the
    /// recurrence signal the product exists to surface.
    public static func resolve(
        store: CrumbtrailSessionStore,
        idleMs: Int64,
        now: Int64,
        mint: () -> String
    ) -> PersistedSession {
        if let persisted = store.read(), now - persisted.lastActivity <= idleMs {
            let refreshed = PersistedSession(id: persisted.id, lastActivity: now)
            store.write(refreshed)
            return refreshed
        }
        let fresh = PersistedSession(id: mint(), lastActivity: now)
        store.write(fresh)
        return fresh
    }

    /// Mint an id in the same shape the other SDKs use: `ses_<date>_<time>_<random>`.
    public static func mintSessionId(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        let stamp = formatter.string(from: now)
        let random = (0..<12).map { _ in "0123456789abcdef".randomElement()! }
        return "ses_\(stamp)_\(String(random))"
    }
}
