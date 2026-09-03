import Foundation

#if canImport(Darwin)
import Darwin
#endif

public let crumbtrailMaxDiagnosticStackCharacters = 8_192
public let crumbtrailMaxDiagnosticStackFrames = 64
public let crumbtrailMaxPendingHangFileBytes = 128 * 1024
public let crumbtrailNativeHangThresholdMilliseconds: Int64 = 5_000
public let crumbtrailMaxNativeHangDurationMilliseconds: Int64 = 86_400_000
public let crumbtrailMaxMetricKitDiagnostics = 32
public let crumbtrailMaxMetricKitPayloads = 32

private let crumbtrailDiagnosticAuthorizationPattern = try! NSRegularExpression(
    pattern: #"(?i)(\b(?:proxy-)?authorization\b["']?[ \t]*[:=][ \t]*["']?)(?:bearer|basic)[ \t]+[^\s,;"']+"#
)

private let crumbtrailDiagnosticCredentialPattern = try! NSRegularExpression(
    pattern: #"(?i)(\b(?:authorization|cookie|set-cookie|proxy-authorization|www-authenticate|x[-_]?api[-_]?key|x[-_]?auth[-_]?token|x[-_]?csrf[-_]?token|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|auth[-_]?(?:token|key)|token|secret|password|passwd|credential|signature|bearer)\b["']?\s*(?:[:=]\s*|\s+)["']?)([^\s,;"']+)"#
)

/// Keep diagnostic text bounded before it reaches the event queue or disk.
public func crumbtrailBoundedDiagnosticText(
    _ value: String?,
    maxCharacters: Int = crumbtrailMaxDiagnosticStackCharacters
) -> String? {
    guard let value, !value.isEmpty, maxCharacters > 0 else { return nil }
    return value.count <= maxCharacters ? value : String(value.prefix(maxCharacters))
}

/// Remove credential-shaped values from diagnostic text before it leaves the device.
public func crumbtrailRedactedDiagnosticText(
    _ value: String?,
    maxCharacters: Int = crumbtrailMaxDiagnosticStackCharacters
) -> String? {
    guard let bounded = crumbtrailBoundedDiagnosticText(value, maxCharacters: maxCharacters)
    else { return nil }
    let authorizationRedacted = crumbtrailDiagnosticAuthorizationPattern.stringByReplacingMatches(
        in: bounded,
        range: NSRange(bounded.startIndex..<bounded.endIndex, in: bounded),
        withTemplate: "$1[REDACTED]"
    )
    let range = NSRange(authorizationRedacted.startIndex..<authorizationRedacted.endIndex, in: authorizationRedacted)
    let redacted = crumbtrailDiagnosticCredentialPattern.stringByReplacingMatches(
        in: authorizationRedacted,
        range: range,
        withTemplate: "$1[REDACTED]"
    )
    return crumbtrailBoundedDiagnosticText(redacted, maxCharacters: maxCharacters)
}

/// A main-thread hang waiting for recovery or a later launch.
public struct CrumbtrailPendingHang: Codable, Equatable, Sendable {
    public let thresholdMs: Int64
    public let observedDurationMs: Int64
    public let stack: String?
    public let at: Int64
    public let startedAt: Int64

    public init(
        thresholdMs: Int64,
        observedDurationMs: Int64,
        stack: String?,
        at: Int64,
        startedAt: Int64? = nil
    ) {
        self.thresholdMs = thresholdMs
        self.observedDurationMs = observedDurationMs
        self.stack = stack
        self.at = at
        self.startedAt = startedAt ?? at
    }
}

public protocol CrumbtrailPendingHangStore: AnyObject {
    var importIdentity: AnyHashable { get }
    func write(_ hang: CrumbtrailPendingHang)
    func read() -> CrumbtrailPendingHang?
    func clear()

    /// Claim the single durable slot without racing another watchdog instance.
    @discardableResult
    func writeIfEmpty(_ hang: CrumbtrailPendingHang) -> Bool

    /// Clear only the record this watchdog claimed, not a replacement record.
    @discardableResult
    func clearIfMatches(_ hang: CrumbtrailPendingHang) -> Bool
}

public extension CrumbtrailPendingHangStore {
    var importIdentity: AnyHashable { ObjectIdentifier(self) }
    @discardableResult
    func writeIfEmpty(_ hang: CrumbtrailPendingHang) -> Bool {
        guard read() == nil else { return false }
        write(hang)
        return read() == hang
    }

    @discardableResult
    func clearIfMatches(_ hang: CrumbtrailPendingHang) -> Bool {
        guard read() == hang else { return false }
        clear()
        return true
    }
}

public final class MemoryPendingHangStore: CrumbtrailPendingHangStore {
    private var hang: CrumbtrailPendingHang?
    private let lock = NSLock()

    public init(hang: CrumbtrailPendingHang? = nil) { self.hang = hang }
    public func write(_ hang: CrumbtrailPendingHang) {
        lock.lock()
        defer { lock.unlock() }
        self.hang = hang
    }
    public func read() -> CrumbtrailPendingHang? {
        lock.lock()
        defer { lock.unlock() }
        return hang
    }
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        hang = nil
    }
    @discardableResult
    public func writeIfEmpty(_ hang: CrumbtrailPendingHang) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard self.hang == nil else { return false }
        self.hang = hang
        return true
    }

    @discardableResult
    public func clearIfMatches(_ hang: CrumbtrailPendingHang) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard self.hang == hang else { return false }
        self.hang = nil
        return true
    }
}

public struct CrumbtrailNativeHang: Equatable, Sendable {
    public let thresholdMs: Int64
    public let observedDurationMs: Int64
    public let recovered: Bool
    public let previousLaunch: Bool
    public let stack: String?

    public init(
        thresholdMs: Int64,
        observedDurationMs: Int64,
        recovered: Bool,
        previousLaunch: Bool,
        stack: String?
    ) {
        self.thresholdMs = thresholdMs
        self.observedDurationMs = observedDurationMs
        self.recovered = recovered
        self.previousLaunch = previousLaunch
        self.stack = stack
    }
}

public protocol CrumbtrailWatchdogTask: AnyObject {
    func cancel()
}

public protocol CrumbtrailWatchdogScheduler: AnyObject {
    @discardableResult
    func schedule(after seconds: TimeInterval, _ task: @escaping () -> Void) -> CrumbtrailWatchdogTask
    func postToMain(_ task: @escaping () -> Void)
    func postToBackground(_ task: @escaping () -> Void)
    func drain()
    func shutdown()
}

public extension CrumbtrailWatchdogScheduler {
    func postToBackground(_ task: @escaping () -> Void) {
        _ = schedule(after: 0, task)
    }

    func drain() {}
}

/// Foreground only watchdog state machine. The platform adapter supplies the
/// timer, main queue and debugger state, which keeps this behavior testable on
/// macOS without UIKit or a simulator.
/// The hang sink returns true only when the event was accepted into the host
/// logger. The durable handoff is cleared only after that acknowledgement.
public final class CrumbtrailMainThreadWatchdog: @unchecked Sendable {
    private let scheduler: CrumbtrailWatchdogScheduler
    private let handoff: CrumbtrailPendingHangStore
    private let onHang: (CrumbtrailNativeHang) -> Bool
    private let now: () -> Int64
    private let wallNow: () -> Int64
    private let isDebuggerAttached: () -> Bool
    private let captureStack: () -> String?
    private let thresholdMs: Int64
    private let checkIntervalMs: Int64
    private let lock = NSLock()
    private var running = false
    private var generation: Int64 = 0
    private var lastHeartbeatAt: Int64 = 0
    private var pendingHang: CrumbtrailPendingHang?
    private var pendingStartedMonotonic: Int64?
    private var checkTask: CrumbtrailWatchdogTask?
    private var debuggerPollTask: CrumbtrailWatchdogTask?
    private var debuggerSuppressed = false

    public init(
        scheduler: CrumbtrailWatchdogScheduler,
        handoff: CrumbtrailPendingHangStore,
        onHang: @escaping (CrumbtrailNativeHang) -> Bool,
        /// Monotonic milliseconds used only for elapsed-time calculations.
        now: @escaping () -> Int64 = {
            Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
        },
        /// Wall-clock milliseconds used only for persisted event timestamps.
        wallNow: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
        isDebuggerAttached: @escaping () -> Bool = { false },
        thresholdMs: Int64 = crumbtrailNativeHangThresholdMilliseconds,
        checkIntervalMs: Int64 = 250,
        captureStack: @escaping () -> String? = { nil }
    ) {
        self.scheduler = scheduler
        self.handoff = handoff
        self.onHang = onHang
        self.now = now
        self.wallNow = wallNow
        self.isDebuggerAttached = isDebuggerAttached
        self.thresholdMs = min(max(1, thresholdMs), crumbtrailMaxNativeHangDurationMilliseconds)
        self.checkIntervalMs = max(1, checkIntervalMs)
        self.captureStack = captureStack
    }

    public var threshold: Int64 { thresholdMs }

    public func start() {
        if debuggerAttached() {
            suppressForDebugger()
            return
        }
        let token: Int64
        lock.lock()
        guard !running else {
            lock.unlock()
            return
        }
        debuggerSuppressed = false
        debuggerPollTask?.cancel()
        debuggerPollTask = nil
        running = true
        generation += 1
        token = generation
        lastHeartbeatAt = now()
        lock.unlock()
        scheduleCheck(token)
        scheduler.postToMain { [weak self] in self?.heartbeat(token) }
    }

    public func resume() { start() }

    public func pause() {
        lock.lock()
        running = false
        debuggerSuppressed = false
        generation += 1
        checkTask?.cancel()
        checkTask = nil
        debuggerPollTask?.cancel()
        debuggerPollTask = nil
        lock.unlock()
    }

    public func stop() {
        pause()
        scheduler.drain()
        scheduler.shutdown()
    }

    private func scheduleCheck(_ token: Int64) {
        let task = scheduler.schedule(after: TimeInterval(checkIntervalMs) / 1_000) {
            [weak self] in self?.check(token)
        }
        lock.lock()
        if running && generation == token {
            checkTask = task
            lock.unlock()
        } else {
            lock.unlock()
            task.cancel()
        }
    }

    private func check(_ token: Int64) {
        lock.lock()
        let active = running && generation == token
        lock.unlock()
        guard active else { return }
        if debuggerAttached() {
            suppressForDebugger()
            return
        }

        let current = now()
        lock.lock()
        if running && generation == token {
            let elapsed = max(0, current - lastHeartbeatAt)
            if elapsed >= thresholdMs && pendingHang == nil && handoff.read() == nil {
                let at = wallNow()
                let pending = CrumbtrailPendingHang(
                    thresholdMs: thresholdMs,
                    observedDurationMs: min(elapsed, crumbtrailMaxNativeHangDurationMilliseconds),
                    stack: crumbtrailRedactedDiagnosticText(captureStack()),
                    at: at,
                    startedAt: max(0, at - elapsed)
                )
                if handoff.writeIfEmpty(pending) {
                    pendingHang = pending
                    pendingStartedMonotonic = lastHeartbeatAt
                }
            }
        }
        lock.unlock()

        scheduler.postToMain { [weak self] in self?.heartbeat(token) }
        scheduleCheck(token)
    }

    private func heartbeat(_ token: Int64) {
        var observation: CrumbtrailNativeHang?
        lock.lock()
        guard running && generation == token else {
            lock.unlock()
            return
        }
        let current = now()
        let pending = pendingHang
        if let pending {
            let duration: Int64
            if let started = pendingStartedMonotonic {
                duration = min(
                    max(pending.observedDurationMs, current - started),
                    crumbtrailMaxNativeHangDurationMilliseconds
                )
            } else {
                duration = min(
                    max(0, pending.observedDurationMs),
                    crumbtrailMaxNativeHangDurationMilliseconds
                )
            }
            pendingHang = nil
            pendingStartedMonotonic = nil
            observation = CrumbtrailNativeHang(
                thresholdMs: pending.thresholdMs,
                observedDurationMs: duration,
                recovered: true,
                previousLaunch: false,
                stack: pending.stack
            )
        }
        lastHeartbeatAt = current
        if let observation, let expectedHang = pending {
            scheduler.postToBackground {
                _ = withPendingHangClaim(self.handoff) {
                    guard self.handoff.read() == expectedHang else { return false }
                    let accepted = self.onHang(observation)
                    if accepted { _ = self.handoff.clearIfMatches(expectedHang) }
                    return accepted
                }
            }
        }
        lock.unlock()
    }

    private func debuggerAttached() -> Bool {
        isDebuggerAttached()
    }

    private func suppressForDebugger() {
        let shouldPoll: Bool
        lock.lock()
        running = false
        generation += 1
        checkTask?.cancel()
        checkTask = nil
        shouldPoll = !debuggerSuppressed
        debuggerSuppressed = true
        lock.unlock()
        if shouldPoll { scheduleDebuggerPoll() }
    }

    private func scheduleDebuggerPoll() {
        lock.lock()
        if !debuggerSuppressed || running {
            lock.unlock()
            return
        }
        let task = scheduler.schedule(after: TimeInterval(checkIntervalMs) / 1_000) {
            [weak self] in self?.pollDebugger()
        }
        if debuggerSuppressed && !running { debuggerPollTask = task } else { task.cancel() }
        lock.unlock()
    }

    private func pollDebugger() {
        lock.lock()
        let shouldPoll = debuggerSuppressed
        lock.unlock()
        guard shouldPoll else { return }
        if debuggerAttached() {
            scheduleDebuggerPoll()
            return
        }
        resumeAfterDebugger()
    }

    /// Transition out of debugger suppression atomically with the running state.
    private func resumeAfterDebugger() {
        var token: Int64 = 0
        lock.lock()
        guard debuggerSuppressed && !running else {
            lock.unlock()
            return
        }
        debuggerSuppressed = false
        debuggerPollTask = nil
        running = true
        generation += 1
        token = generation
        lastHeartbeatAt = now()
        lock.unlock()

        // Pause can win after the transition. scheduleCheck cancels its task
        // when it observes the newer generation, and the heartbeat is a no-op.
        scheduleCheck(token)
        scheduler.postToMain { [weak self] in self?.heartbeat(token) }
    }
}

private enum PendingHangImports {
    static let lock = NSLock()
    static var active: Set<AnyHashable> = []
}

/// Claims the import without holding a storage or registry lock during the callback.
@discardableResult
public func drainPendingHang(
    _ handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Bool
) -> Bool {
    withPendingHangClaim(handoff) { drainClaimedPendingHang(handoff, onHang: onHang) }
}

private func withPendingHangClaim(_ handoff: CrumbtrailPendingHangStore, action: () -> Bool) -> Bool {
    let identity = handoff.importIdentity
    PendingHangImports.lock.lock()
    let claimed = PendingHangImports.active.insert(identity).inserted
    PendingHangImports.lock.unlock()
    guard claimed else { return false }
    defer {
        PendingHangImports.lock.lock()
        PendingHangImports.active.remove(identity)
        PendingHangImports.lock.unlock()
    }
    return action()
}

private func drainClaimedPendingHang(
    _ handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Bool
) -> Bool {
    guard let pending = handoff.read() else { return false }
    let accepted = onHang(
        CrumbtrailNativeHang(
            thresholdMs: min(
                max(0, pending.thresholdMs), crumbtrailMaxNativeHangDurationMilliseconds
            ),
            observedDurationMs: min(
                max(0, pending.observedDurationMs), crumbtrailMaxNativeHangDurationMilliseconds
            ),
            recovered: false,
            previousLaunch: true,
                stack: crumbtrailRedactedDiagnosticText(pending.stack)
        )
    )
    if accepted { _ = handoff.clearIfMatches(pending) }
    return accepted
}

/// Durable hang handoff in Application Support, alongside the crash handoff.
/// A bounded JSON file with atomic replacement survives process termination
/// without using UserDefaults as a second persistence mechanism. Replacement
/// files live in a dedicated directory so cleanup never scans the whole support
/// directory.
public final class ApplicationSupportPendingHangStore: CrumbtrailPendingHangStore {
    public var importIdentity: AnyHashable {
        fileURL.map { AnyHashable($0.standardizedFileURL.resolvingSymlinksInPath().path) }
            ?? AnyHashable(ObjectIdentifier(self))
    }
    private static let fileName = "crumbtrail-pending-hang.json"
    private static let temporaryDirectoryName = "crumbtrail-pending-hang-tmp"
    private static let temporaryFileSuffix = ".tmp"
    private static let temporaryFileMarker = ".replacement-"
    private static let temporaryFileLifetime: TimeInterval = 24 * 60 * 60
    private static let maximumTemporaryFilesToInspect = 32
    private static let maximumTemporaryFilesToRemove = 8
    private static let handoffLock = NSLock()
    private let fileURL: URL?
    private let fileManager: FileManager

    public init(fileURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileURL = fileURL ?? CrumbtrailCrashStore.applicationSupportFileURL(
            named: Self.fileName
        )
        self.fileManager = fileManager
        cleanupTemporaryFiles()
    }

    private func encodedData(for hang: CrumbtrailPendingHang) -> Data? {
        try? JSONEncoder().encode(
            CrumbtrailPendingHang(
                thresholdMs: min(max(0, hang.thresholdMs), crumbtrailMaxNativeHangDurationMilliseconds),
                observedDurationMs: min(max(0, hang.observedDurationMs), crumbtrailMaxNativeHangDurationMilliseconds),
                stack: crumbtrailRedactedDiagnosticText(hang.stack),
                at: hang.at,
                startedAt: hang.startedAt
            )
        )
    }

    private func writeUnlocked(_ hang: CrumbtrailPendingHang) -> Bool {
        guard let fileURL,
              let data = encodedData(for: hang),
              data.count <= crumbtrailMaxPendingHangFileBytes
        else { return false }

        cleanupTemporaryFiles()
        let temporaryDirectory = temporaryDirectoryURL(for: fileURL)
        let temporaryName = fileURL.lastPathComponent
            + Self.temporaryFileMarker
            + UUID().uuidString
            + Self.temporaryFileSuffix
        let temporaryURL = temporaryDirectory.appendingPathComponent(temporaryName)
        do {
            try fileManager.createDirectory(
                at: temporaryDirectory,
                withIntermediateDirectories: true
            )
            try data.write(to: temporaryURL, options: .atomic)
            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(fileURL, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: fileURL)
            }
            return true
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            return false
        }
    }

    public func write(_ hang: CrumbtrailPendingHang) {
        Self.handoffLock.lock()
        defer { Self.handoffLock.unlock() }
        _ = writeUnlocked(hang)
    }

    @discardableResult
    public func writeIfEmpty(_ hang: CrumbtrailPendingHang) -> Bool {
        Self.handoffLock.lock()
        defer { Self.handoffLock.unlock() }
        guard readUnlocked() == nil else { return false }
        return writeUnlocked(hang)
    }

    @discardableResult
    public func clearIfMatches(_ hang: CrumbtrailPendingHang) -> Bool {
        Self.handoffLock.lock()
        defer { Self.handoffLock.unlock() }
        guard readUnlocked() == hang else { return false }
        cleanupTemporaryFiles()
        guard let fileURL else { return false }
        do {
            try fileManager.removeItem(at: fileURL)
            return true
        } catch {
            return false
        }
    }

    private func readUnlocked() -> CrumbtrailPendingHang? {
        cleanupTemporaryFiles()
        guard let fileURL,
              let data = try? Data(contentsOf: fileURL),
              data.count <= crumbtrailMaxPendingHangFileBytes,
              let hang = try? JSONDecoder().decode(CrumbtrailPendingHang.self, from: data)
        else { return nil }
        return CrumbtrailPendingHang(
            thresholdMs: min(
                max(1, hang.thresholdMs),
                crumbtrailMaxNativeHangDurationMilliseconds
            ),
            observedDurationMs: min(
                max(0, hang.observedDurationMs),
                crumbtrailMaxNativeHangDurationMilliseconds
            ),
            stack: crumbtrailRedactedDiagnosticText(hang.stack),
            at: hang.at,
            startedAt: hang.startedAt
        )
    }

    public func read() -> CrumbtrailPendingHang? {
        Self.handoffLock.lock()
        defer { Self.handoffLock.unlock() }
        return readUnlocked()
    }

    public func clear() {
        Self.handoffLock.lock()
        defer { Self.handoffLock.unlock() }
        cleanupTemporaryFiles()
        guard let fileURL else { return }
        try? fileManager.removeItem(at: fileURL)
    }

    /// Removes only old temporary replacements owned by this handoff file.
    /// Fresh replacements may still belong to an interrupted writer, so age is
    /// required before deletion and both inspection and removal are bounded.
    private func cleanupTemporaryFiles(now: Date = Date()) {
        guard let fileURL else { return }
        let directory = temporaryDirectoryURL(for: fileURL)
        let prefix = fileURL.lastPathComponent + Self.temporaryFileMarker
        guard let entries = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [],
            errorHandler: { _, _ in true }
        ) else { return }

        let cutoff = now.addingTimeInterval(-Self.temporaryFileLifetime)
        var inspected = 0
        var removed = 0
        while inspected < Self.maximumTemporaryFilesToInspect,
              let entry = entries.nextObject() as? URL {
            inspected += 1
            let name = entry.lastPathComponent
            guard name.hasPrefix(prefix), name.hasSuffix(Self.temporaryFileSuffix),
                  let values = try? entry.resourceValues(
                      forKeys: [.contentModificationDateKey, .isRegularFileKey]
                  ),
                  values.isRegularFile == true,
                  let modified = values.contentModificationDate,
                  modified < cutoff,
                  removed < Self.maximumTemporaryFilesToRemove
            else { continue }
            if (try? fileManager.removeItem(at: entry)) != nil { removed += 1 }
        }
    }

    private func temporaryDirectoryURL(for fileURL: URL) -> URL {
        fileURL.deletingLastPathComponent().appendingPathComponent(
            Self.temporaryDirectoryName,
            isDirectory: true
        )
    }
}

/// A small dispatch based scheduler used by the UIKit adapter.
public final class CrumbtrailDispatchWatchdogScheduler: CrumbtrailWatchdogScheduler,
    @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.crumbtrail.native-watchdog", qos: .utility)
    private let queueKey = DispatchSpecificKey<UInt8>()
    private let lock = NSLock()
    private var stopped = false

    public init() {
        queue.setSpecific(key: queueKey, value: 1)
    }

    @discardableResult
    public func schedule(
        after seconds: TimeInterval,
        _ task: @escaping () -> Void
    ) -> CrumbtrailWatchdogTask {
        let item = DispatchWorkItem { task() }
        lock.lock()
        let shouldSchedule = !stopped
        lock.unlock()
        if shouldSchedule {
            queue.asyncAfter(deadline: .now() + max(0, seconds), execute: item)
        } else {
            item.cancel()
        }
        return DispatchWorkItemTask(item)
    }

    public func postToMain(_ task: @escaping () -> Void) {
        DispatchQueue.main.async(execute: task)
    }

    public func postToBackground(_ task: @escaping () -> Void) {
        queue.async(execute: task)
    }

    public func shutdown() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    public func drain() {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return }
        queue.sync {}
    }

    private final class DispatchWorkItemTask: CrumbtrailWatchdogTask {
        private let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }
}

/// Debugger detection uses the documented process table flag and does not
/// install signal handlers or alter host exception behavior.
public enum CrumbtrailDebugger {
    public static var isAttached: () -> Bool = {
        #if canImport(Darwin)
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let result = mib.withUnsafeMutableBufferPointer { pointer in
            withUnsafeMutablePointer(to: &info) { process in
                sysctl(pointer.baseAddress, u_int(pointer.count), process, &size, nil, 0)
            }
        }
        return result == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
        #else
        return false
        #endif
    }
}

// MARK: - MetricKit diagnostic import seam

public struct CrumbtrailNativeCrash: Equatable, Sendable {
    public let message: String
    public let stack: String?
    public let signal: String?
    public let at: Int64?

    public init(message: String, stack: String?, signal: String?, at: Int64? = nil) {
        self.message = message
        self.stack = stack
        self.signal = signal
        self.at = at
    }
}

public protocol CrumbtrailMetricKitSource: AnyObject {
    func start(_ handler: @escaping ([Data]) -> Void)
    func stop()
}

/// Imports only the two shared diagnostic contracts from MetricKit payload JSON.
/// Other MetricKit measurements remain outside the SDK's event vocabulary.
public final class CrumbtrailMetricKitCollector: @unchecked Sendable {
    private let source: CrumbtrailMetricKitSource
    private let emitHang: (CrumbtrailNativeHang) -> Void
    private let emitCrash: (CrumbtrailNativeCrash) -> Void

    public init(
        source: CrumbtrailMetricKitSource,
        emitHang: @escaping (CrumbtrailNativeHang) -> Void,
        emitCrash: @escaping (CrumbtrailNativeCrash) -> Void
    ) {
        self.source = source
        self.emitHang = emitHang
        self.emitCrash = emitCrash
    }

    public func start() {
        source.start { [weak self] payloads in
            guard let self else { return }
            for payload in payloads.prefix(crumbtrailMaxMetricKitPayloads) {
                self.consume(payload)
            }
        }
    }

    public func stop() { source.stop() }

    private func consume(_ data: Data) {
        // MetricKit payloads are OS generated. Refuse unexpectedly large or
        // malformed values before they can consume memory in JSONSerialization.
        guard data.count <= 2 * 1024 * 1024,
              let root = try? JSONSerialization.jsonObject(with: data) else { return }
        for diagnostic in dictionaries(
            forKey: "hangDiagnostics", in: root, limit: crumbtrailMaxMetricKitDiagnostics
        ) {
            guard let duration = durationMilliseconds(in: diagnostic) else { continue }
            emitHang(
                CrumbtrailNativeHang(
                    thresholdMs: crumbtrailNativeHangThresholdMilliseconds,
                    observedDurationMs: min(max(0, duration), crumbtrailMaxNativeHangDurationMilliseconds),
                    recovered: false,
                    previousLaunch: true,
                    stack: stackString(in: diagnostic)
                )
            )
        }
        for diagnostic in dictionaries(
            forKey: "crashDiagnostics", in: root, limit: crumbtrailMaxMetricKitDiagnostics
        ) {
            let message = firstString(
                keys: ["terminationReason", "exceptionType", "exceptionReason"],
                in: diagnostic
            ) ?? "MetricKit crash"
            emitCrash(
                CrumbtrailNativeCrash(
                    message: crumbtrailRedactedDiagnosticText(message, maxCharacters: 1_024)
                        ?? "MetricKit crash",
                    stack: stackString(in: diagnostic),
                    signal: crumbtrailRedactedDiagnosticText(
                        firstString(keys: ["signal"], in: diagnostic), maxCharacters: 128
                    ),
                    at: timestampMilliseconds(in: diagnostic)
                )
            )
        }
    }

    private func dictionaries(
        forKey key: String,
        in value: Any,
        depth: Int = 0,
        limit: Int
    ) -> [[String: Any]] {
        guard depth < 12, limit > 0 else { return [] }
        if let object = value as? [String: Any] {
            var result: [[String: Any]] = []
            if let matches = object[key] as? [[String: Any]] {
                result.append(contentsOf: matches.prefix(limit))
            }
            for child in object.values where result.count < limit {
                result.append(contentsOf: dictionaries(
                    forKey: key,
                    in: child,
                    depth: depth + 1,
                    limit: limit - result.count
                ))
            }
            return result
        }
        if let array = value as? [Any] {
            var result: [[String: Any]] = []
            for child in array where result.count < limit {
                result.append(contentsOf: dictionaries(
                    forKey: key,
                    in: child,
                    depth: depth + 1,
                    limit: limit - result.count
                ))
            }
            return result
        }
        return []
    }

    private func firstString(keys: [String], in object: [String: Any]) -> String? {
        for key in keys {
            if let value = object[key] as? String, !value.isEmpty { return value }
            if let value = object[key] as? NSNumber { return value.stringValue }
        }
        return nil
    }

    private func durationMilliseconds(in object: [String: Any]) -> Int64? {
        for key in ["hangDuration", "duration", "hangDurationSeconds"] {
            guard let value = object[key] else { continue }
            if let number = value as? NSNumber {
                return safeMilliseconds(
                    number.doubleValue,
                    multiplier: key.hasSuffix("Seconds") ? 1_000 : 1
                )
            }
            if let string = value as? String {
                if let number = Double(string) {
                    return safeMilliseconds(
                        number,
                        multiplier: key.hasSuffix("Seconds") ? 1_000 : 1
                    )
                }
                if let match = string.range(of: "PT"), string.hasSuffix("S") {
                    let seconds = String(string[match.upperBound..<string.index(before: string.endIndex)])
                    if let number = Double(seconds) {
                        return safeMilliseconds(number, multiplier: 1_000)
                    }
                }
            }
        }
        return nil
    }

    private func safeMilliseconds(_ value: Double, multiplier: Double) -> Int64? {
        guard !value.isNaN else { return nil }
        if value.isInfinite { return value.sign == .minus ? 0 : crumbtrailMaxNativeHangDurationMilliseconds }
        let milliseconds = max(0, value * multiplier)
        if milliseconds.isInfinite { return crumbtrailMaxNativeHangDurationMilliseconds }
        let capped = min(milliseconds, Double(crumbtrailMaxNativeHangDurationMilliseconds))
        return Int64(capped.rounded(.towardZero))
    }

    private func timestampMilliseconds(in object: [String: Any]) -> Int64? {
        for key in ["timestamp", "timeStamp", "date"] {
            if let number = object[key] as? NSNumber {
                let value = number.doubleValue
                guard value.isFinite, value >= 0, value < Double(Int64.max) else { continue }
                return Int64(value.rounded(.towardZero))
            }
            if let string = object[key] as? String,
               let date = ISO8601DateFormatter().date(from: string) {
                let value = date.timeIntervalSince1970 * 1_000
                guard value.isFinite, value >= 0, value < Double(Int64.max) else { continue }
                return Int64(value.rounded(.towardZero))
            }
        }
        return nil
    }

    private func stackString(in value: Any, depth: Int = 0, lines: inout [String]) {
        guard depth < 16, lines.count < crumbtrailMaxDiagnosticStackFrames else { return }
        if let object = value as? [String: Any] {
            let symbol = object["symbol"] as? String
            let binary = object["binaryName"] as? String
            let source = object["sourceFile"] as? String
            if let text = symbol ?? binary ?? source,
               let redacted = crumbtrailRedactedDiagnosticText(text),
               !redacted.isEmpty {
                lines.append(redacted)
            }
            for child in object.values { stackString(in: child, depth: depth + 1, lines: &lines) }
        } else if let array = value as? [Any] {
            for child in array { stackString(in: child, depth: depth + 1, lines: &lines) }
        }
    }

    private func stackString(in object: [String: Any]) -> String? {
        var lines: [String] = []
        for key in ["callStackTree", "callStackPerThread", "callStackRootFrames"] {
            if let value = object[key] { stackString(in: value, lines: &lines) }
        }
        return crumbtrailRedactedDiagnosticText(lines.joined(separator: "\n"))
    }
}

#if canImport(MetricKit) && !os(tvOS) && !os(watchOS)
import MetricKit

/// Optional system adapter. The SDK links MetricKit only when the host target
/// provides it and receives diagnostics as JSON through the platform seam.
@available(iOS 14.0, macOS 12.0, *)
public final class CrumbtrailSystemMetricKitSource: NSObject, CrumbtrailMetricKitSource,
    MXMetricManagerSubscriber {
    private var handler: (([Data]) -> Void)?

    public override init() { super.init() }

    public func start(_ handler: @escaping ([Data]) -> Void) {
        self.handler = handler
        MXMetricManager.shared.add(self)
    }

    public func stop() {
        MXMetricManager.shared.remove(self)
        handler = nil
    }

    public func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let data = payloads.map { $0.jsonRepresentation() }
        handler?(data)
    }
}
#endif
