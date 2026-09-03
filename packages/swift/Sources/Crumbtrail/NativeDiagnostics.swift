import Foundation

#if canImport(Darwin)
import Darwin
#endif

public let crumbtrailMaxDiagnosticStackCharacters = 8_192
public let crumbtrailMaxDiagnosticStackFrames = 64
public let crumbtrailNativeHangThresholdMilliseconds: Int64 = 5_000
public let crumbtrailMaxNativeHangDurationMilliseconds: Int64 = 86_400_000

/// Keep diagnostic text bounded before it reaches the event queue or disk.
public func crumbtrailBoundedDiagnosticText(
    _ value: String?,
    maxCharacters: Int = crumbtrailMaxDiagnosticStackCharacters
) -> String? {
    guard let value, !value.isEmpty, maxCharacters > 0 else { return nil }
    return value.count <= maxCharacters ? value : String(value.prefix(maxCharacters))
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
    func write(_ hang: CrumbtrailPendingHang)
    func read() -> CrumbtrailPendingHang?
    func clear()
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
    func shutdown()
}

/// Foreground only watchdog state machine. The platform adapter supplies the
/// timer, main queue and debugger state, which keeps this behavior testable on
/// macOS without UIKit or a simulator.
public final class CrumbtrailMainThreadWatchdog: @unchecked Sendable {
    private let scheduler: CrumbtrailWatchdogScheduler
    private let handoff: CrumbtrailPendingHangStore
    private let onHang: (CrumbtrailNativeHang) -> Void
    private let now: () -> Int64
    private let isDebuggerAttached: () -> Bool
    private let captureStack: () -> String?
    private let thresholdMs: Int64
    private let checkIntervalMs: Int64
    private let lock = NSLock()
    private var running = false
    private var generation: Int64 = 0
    private var lastHeartbeatAt: Int64 = 0
    private var pendingAt: Int64?
    private var checkTask: CrumbtrailWatchdogTask?

    public init(
        scheduler: CrumbtrailWatchdogScheduler,
        handoff: CrumbtrailPendingHangStore,
        onHang: @escaping (CrumbtrailNativeHang) -> Void,
        now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
        isDebuggerAttached: @escaping () -> Bool = { false },
        thresholdMs: Int64 = crumbtrailNativeHangThresholdMilliseconds,
        checkIntervalMs: Int64 = 250,
        captureStack: @escaping () -> String? = { nil }
    ) {
        self.scheduler = scheduler
        self.handoff = handoff
        self.onHang = onHang
        self.now = now
        self.isDebuggerAttached = isDebuggerAttached
        self.thresholdMs = min(max(1, thresholdMs), crumbtrailMaxNativeHangDurationMilliseconds)
        self.checkIntervalMs = max(1, checkIntervalMs)
        self.captureStack = captureStack
    }

    public var threshold: Int64 { thresholdMs }

    public func start() {
        if isDebuggerAttached() {
            pause()
            return
        }
        let token: Int64
        lock.lock()
        guard !running else {
            lock.unlock()
            return
        }
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
        generation += 1
        checkTask?.cancel()
        checkTask = nil
        lock.unlock()
    }

    public func stop() {
        pause()
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
        if isDebuggerAttached() {
            pause()
            return
        }

        let current = now()
        lock.lock()
        let elapsed = max(0, current - lastHeartbeatAt)
        if elapsed >= thresholdMs && pendingAt == nil && handoff.read() == nil {
            let at = current
            let pending = CrumbtrailPendingHang(
                thresholdMs: thresholdMs,
                observedDurationMs: min(elapsed, crumbtrailMaxNativeHangDurationMilliseconds),
                stack: crumbtrailBoundedDiagnosticText(captureStack()),
                at: at,
                startedAt: lastHeartbeatAt
            )
            handoff.write(pending)
            pendingAt = at
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
        let pending = handoff.read()
        if let activeAt = pendingAt, let pending, pending.at == activeAt {
            let duration = min(
                max(pending.observedDurationMs, current - pending.startedAt),
                crumbtrailMaxNativeHangDurationMilliseconds
            )
            handoff.clear()
            pendingAt = nil
            observation = CrumbtrailNativeHang(
                thresholdMs: pending.thresholdMs,
                observedDurationMs: duration,
                recovered: true,
                previousLaunch: false,
                stack: pending.stack
            )
        }
        lastHeartbeatAt = current
        lock.unlock()
        if let observation { onHang(observation) }
    }
}

public func drainPendingHang(
    _ handoff: CrumbtrailPendingHangStore,
    onHang: (CrumbtrailNativeHang) -> Void
) {
    guard let pending = handoff.read() else { return }
    handoff.clear()
    onHang(
        CrumbtrailNativeHang(
            thresholdMs: min(
                max(0, pending.thresholdMs), crumbtrailMaxNativeHangDurationMilliseconds
            ),
            observedDurationMs: min(
                max(0, pending.observedDurationMs), crumbtrailMaxNativeHangDurationMilliseconds
            ),
            recovered: false,
            previousLaunch: true,
            stack: crumbtrailBoundedDiagnosticText(pending.stack)
        )
    )
}

/// Durable handoff in UserDefaults. A separate key keeps this additive to the
/// existing crash handoff and lets the host clear either diagnostic independently.
public final class UserDefaultsPendingHangStore: CrumbtrailPendingHangStore {
    private let defaults: UserDefaults
    private let key: String

    public init(
        defaults: UserDefaults = .standard,
        key: String = "ai.crumbtrail.pending-hang"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func write(_ hang: CrumbtrailPendingHang) {
        guard let data = try? JSONEncoder().encode(hang) else { return }
        defaults.set(data, forKey: key)
    }

    public func read() -> CrumbtrailPendingHang? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CrumbtrailPendingHang.self, from: data)
    }

    public func clear() { defaults.removeObject(forKey: key) }
}

/// A small dispatch based scheduler used by the UIKit adapter.
public final class CrumbtrailDispatchWatchdogScheduler: CrumbtrailWatchdogScheduler,
    @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.crumbtrail.native-watchdog", qos: .utility)
    private let lock = NSLock()
    private var stopped = false

    public init() {}

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

    public func shutdown() {
        lock.lock()
        stopped = true
        lock.unlock()
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
            for payload in payloads { self.consume(payload) }
        }
    }

    public func stop() { source.stop() }

    private func consume(_ data: Data) {
        // MetricKit payloads are OS generated. Refuse unexpectedly large or
        // malformed values before they can consume memory in JSONSerialization.
        guard data.count <= 2 * 1024 * 1024,
              let root = try? JSONSerialization.jsonObject(with: data) else { return }
        for diagnostic in dictionaries(forKey: "hangDiagnostics", in: root) {
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
        for diagnostic in dictionaries(forKey: "crashDiagnostics", in: root) {
            let message = firstString(
                keys: ["terminationReason", "exceptionType", "exceptionReason"],
                in: diagnostic
            ) ?? "MetricKit crash"
            emitCrash(
                CrumbtrailNativeCrash(
                    message: String(message.prefix(1_024)),
                    stack: stackString(in: diagnostic),
                    signal: firstString(keys: ["signal"], in: diagnostic),
                    at: timestampMilliseconds(in: diagnostic)
                )
            )
        }
    }

    private func dictionaries(forKey key: String, in value: Any, depth: Int = 0) -> [[String: Any]] {
        guard depth < 12 else { return [] }
        if let object = value as? [String: Any] {
            var result: [[String: Any]] = []
            if let matches = object[key] as? [[String: Any]] { result.append(contentsOf: matches) }
            for child in object.values { result.append(contentsOf: dictionaries(forKey: key, in: child, depth: depth + 1)) }
            return result
        }
        if let array = value as? [Any] {
            return array.flatMap { dictionaries(forKey: key, in: $0, depth: depth + 1) }
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
                let seconds = key.hasSuffix("Seconds") ? number.doubleValue : number.doubleValue
                return Int64(max(0, seconds * (key.hasSuffix("Seconds") ? 1_000 : 1)))
            }
            if let string = value as? String {
                if let number = Double(string) { return Int64(max(0, number * 1_000)) }
                if let match = string.range(of: "PT"), string.hasSuffix("S") {
                    let seconds = String(string[match.upperBound..<string.index(before: string.endIndex)])
                    if let number = Double(seconds) { return Int64(max(0, number * 1_000)) }
                }
            }
        }
        return nil
    }

    private func timestampMilliseconds(in object: [String: Any]) -> Int64? {
        for key in ["timestamp", "timeStamp", "date"] {
            if let number = object[key] as? NSNumber { return number.int64Value }
            if let string = object[key] as? String,
               let date = ISO8601DateFormatter().date(from: string) {
                return Int64(date.timeIntervalSince1970 * 1_000)
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
            if let text = symbol ?? binary ?? source, !text.isEmpty { lines.append(text) }
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
        return crumbtrailBoundedDiagnosticText(lines.joined(separator: "\n"))
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
