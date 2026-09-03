import Foundation

/// SDK identity stamped on every event.
public enum CrumbtrailSDK {
    public static let name = "crumbtrail-swift"
    public static let version = "0.1.0"
    public static var descriptor: CrumbtrailSDKDescriptor {
        CrumbtrailSDKDescriptor(name: name, version: version)
    }
}

/// A window of capture that was lost, and why.
///
/// Recorded rather than swallowed. A session missing 200 events reads exactly
/// like a session where nothing happened, so the gap has to be a fact in the
/// timeline instead of an absence in it.
public struct CrumbtrailCaptureGap: Equatable, Sendable {
    public let eventCount: Int
    public let reason: String
    public let at: Int64
}

/// The capture session.
///
/// Deliberately not a singleton-only API: `Crumbtrail.start` returns an instance
/// and also parks it on `Crumbtrail.shared` for the common case. Tests, and any
/// host that runs two endpoints, need to be able to hold more than one.
public final class Crumbtrail: @unchecked Sendable {
    public private(set) static var shared: Crumbtrail?

    public let config: CrumbtrailConfig
    public private(set) var sessionId: String
    public private(set) var capabilities: [String]
    public private(set) var gaps: [CrumbtrailCaptureGap] = []

    private let transport: CrumbtrailTransport
    private let store: CrumbtrailSessionStore
    private let queue: CrumbtrailEventQueue
    private let clock: () -> Int64
    private let lock = NSLock()
    private let lifecycleLock = NSLock()
    private var flushTimer: Timer?
    private var collectorCleanups: [() -> Void] = []
    private var stopped = false

    public init(
        config: CrumbtrailConfig,
        transport: CrumbtrailTransport? = nil,
        store: CrumbtrailSessionStore = UserDefaultsSessionStore(),
        deviceInfo: CrumbtrailDeviceInfo = .current(),
        capabilities: [String] = [],
        clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.config = config
        self.transport = transport ?? CrumbtrailHTTPTransport(
            endpoint: config.endpoint,
            authToken: config.ingestKey
        )
        self.store = store
        self.queue = CrumbtrailEventQueue(capacity: config.queueCapacity)
        self.clock = clock
        self.capabilities = capabilities

        let session = CrumbtrailSessionResolver.resolve(
            store: store,
            idleMs: config.sessionIdleMs,
            now: clock(),
            mint: { CrumbtrailSessionResolver.mintSessionId() }
        )
        self.sessionId = session.id

        let metadata = JSONValue.object(compacting: [
            "service": config.service.map(JSONValue.string),
            "platform": .string(CrumbtrailPlatform.ios.rawValue),
            "app": deviceInfo.appJSON,
            "device": deviceInfo.deviceJSON,
        ])
        let announce = self.transport
        let id = session.id
        Task { await announce.startSession(id: id, metadata: metadata) }

        if config.collectors.environment {
            addEvent(
                kind: .environment,
                data: .object(compacting: [
                    "kind": .string("snapshot"),
                    "device": deviceInfo.deviceJSON,
                    "app": deviceInfo.appJSON,
                    "locale": deviceInfo.locale.map(JSONValue.string),
                ])
            )
        }
    }

    /// Start capture and install it as `Crumbtrail.shared`.
    @discardableResult
    public static func start(
        config: CrumbtrailConfig,
        transport: CrumbtrailTransport? = nil,
        store: CrumbtrailSessionStore = UserDefaultsSessionStore()
    ) -> Crumbtrail {
        let instance = Crumbtrail(config: config, transport: transport, store: store)
        instance.installCollectors()
        instance.startFlushTimer()
        shared = instance
        return instance
    }

    // MARK: - Recording

    @discardableResult
    public func addEvent(
        kind: CrumbtrailEventKind,
        data: JSONValue,
        target: CrumbtrailTarget? = nil
    ) -> Bool {
        lifecycleLock.lock()
        guard !stopped else {
            lifecycleLock.unlock()
            return false
        }
        let event = CrumbtrailEvent(
            timestamp: clock(),
            kind: kind,
            data: data,
            platform: .ios,
            sdk: CrumbtrailSDK.descriptor,
            capabilities: capabilities,
            target: target
        )
        queue.append(event)
        lifecycleLock.unlock()
        // Touch the session so a resumed one does not expire mid-use.
        store.write(PersistedSession(id: sessionId, lastActivity: clock()))

        if queue.count >= config.flushBatchSize {
            Task { await flush() }
        }
        return true
    }

    /// Record a caught error. `fatal` stays false: the process survived.
    public func recordError(
        _ error: Error,
        fatal: Bool = false,
        source: String = "manual"
    ) {
        addEvent(
            kind: .error,
            data: .object(compacting: [
                "msg": .string(
                    crumbtrailRedactedDiagnosticText(
                        String(describing: error),
                        maxCharacters: 1_024
                    ) ?? "unknown error"
                ),
                "fatal": .bool(fatal),
                "source": .string(
                    crumbtrailRedactedDiagnosticText(source, maxCharacters: 256) ?? "manual"
                ),
            ])
        )
    }

    /// Record a completed request. URL and headers go through redaction first.
    public func recordRequest(
        url: String,
        method: String,
        status: Int?,
        durationMs: Int64,
        source: String = "urlsession",
        error: String? = nil
    ) {
        addEvent(
            kind: .network,
            data: .object(compacting: [
                "url": .string(CrumbtrailRedaction.redactURL(url)),
                "method": .string(method.uppercased()),
                "status": status.map { JSONValue.int(Int64($0)) },
                "ok": status.map { JSONValue.bool((200..<300).contains($0)) },
                "dur": .int(durationMs),
                "source": .string(
                    crumbtrailRedactedDiagnosticText(source, maxCharacters: 256) ?? "urlsession"
                ),
                "error": error
                    .flatMap { crumbtrailRedactedDiagnosticText($0, maxCharacters: 1_024) }
                    .map(JSONValue.string),
            ])
        )
    }

    // MARK: - Delivery

    /// Send everything buffered.
    ///
    /// A refusal is not a retry: the server already answered, and the identical
    /// batch would be refused identically. It becomes a declared gap instead. A
    /// network failure IS retried, by putting the batch back at the front so the
    /// timeline keeps its order.
    public func flush() async {
        let batch = queue.drain()
        guard !batch.isEmpty else { return }
        do {
            try await transport.sendEvents(sessionId: sessionId, events: batch)
        } catch let error as CrumbtrailDeliveryError {
            switch error {
            case .unreachable:
                queue.requeue(batch)
            case .refused(let status, let count):
                recordGap(count: count, reason: "refused-\(status)")
            }
        } catch {
            queue.requeue(batch)
        }
    }

    private func recordGap(count: Int, reason: String) {
        lock.lock()
        gaps.append(CrumbtrailCaptureGap(eventCount: count, reason: reason, at: clock()))
        lock.unlock()
    }

    /// Number of events dropped because the buffer filled faster than it drained.
    public var droppedEventCount: Int { queue.dropped }

    // MARK: - Lifecycle

    private func startFlushTimer() {
        guard config.flushIntervalSeconds > 0 else { return }
        let timer = Timer.scheduledTimer(
            withTimeInterval: config.flushIntervalSeconds,
            repeats: true
        ) { [weak self] _ in
            guard let self else { return }
            Task { await self.flush() }
        }
        flushTimer = timer
    }

    public func stop() async {
        guard markStopped() else { return }
        flushTimer?.invalidate()
        flushTimer = nil
        for cleanup in collectorCleanups.reversed() { cleanup() }
        collectorCleanups = []
        await flush()
        await transport.endSession(id: sessionId)
        if Crumbtrail.shared === self { Crumbtrail.shared = nil }
    }

    func registerCleanup(_ cleanup: @escaping () -> Void) {
        collectorCleanups.append(cleanup)
    }

    private func markStopped() -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard !stopped else { return false }
        stopped = true
        return true
    }
}
