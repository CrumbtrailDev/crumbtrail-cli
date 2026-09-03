import Foundation

#if canImport(UIKit) && !os(macOS)
import UIKit
#endif

/// Holds the uncaught-exception handler that was installed before Crumbtrail's.
///
/// Exists only because the handler is a C function pointer and therefore cannot
/// capture context. Global mutable state is the trade for being able to chain to
/// a host's existing crash reporter instead of silently replacing it.
enum CrumbtrailExceptionChain {
    private static let lock = NSLock()
    private static var previous: (@convention(c) (NSException) -> Void)?
    private static var installedAddress: UnsafeRawPointer?
    private static var registrations: Set<UInt64> = []
    private static var nextRegistration: UInt64 = 0

    static var activeRegistrationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return registrations.count
    }

    static func install() -> () -> Void {
        lock.lock()
        nextRegistration += 1
        let registration = nextRegistration
        if registrations.isEmpty {
            previous = NSGetUncaughtExceptionHandler()
            let handler: @convention(c) (NSException) -> Void = { exception in
                CrumbtrailExceptionChain.handle(exception)
            }
            installedAddress = unsafeBitCast(handler, to: UnsafeRawPointer.self)
            NSSetUncaughtExceptionHandler(handler)
        }
        registrations.insert(registration)
        lock.unlock()
        return { remove(registration) }
    }

    private static func handle(_ exception: NSException) {
        CrumbtrailCrashStore.writePending(
            message: exception.reason ?? exception.name.rawValue,
            stack: exception.callStackSymbols.joined(separator: "\n"),
            signal: exception.name.rawValue
        )
        lock.lock()
        let handler = previous
        lock.unlock()
        handler?(exception)
    }

    private static func remove(_ registration: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        registrations.remove(registration)
        guard registrations.isEmpty else { return }
        let currentAddress = NSGetUncaughtExceptionHandler().map {
            unsafeBitCast($0, to: UnsafeRawPointer.self)
        }
        if currentAddress == installedAddress {
            NSSetUncaughtExceptionHandler(previous)
        }
        installedAddress = nil
        previous = nil
    }
}

extension Crumbtrail {
    /// Attach the platform collectors.
    ///
    /// Everything UIKit-specific is behind a compile guard so the contract,
    /// session, queue, transport and redaction layers can be exercised by
    /// `swift test` on a developer machine and in CI with no simulator. That is
    /// not a convenience: a test suite that only runs on a booted simulator is
    /// a test suite that stops running.
    func installCollectors() {
        if config.collectors.errors { installErrorCollector() }
        #if canImport(UIKit) && !os(macOS)
        if config.collectors.needsApplicationLifecycleObserver || config.collectors.nativeDiagnostics {
            installLifecycleCollector()
        }
        #if !os(tvOS)
        if config.collectors.navigation { installOrientationCollector() }
        #endif
        #endif
        #if canImport(MetricKit) && !os(tvOS) && !os(watchOS)
        if config.collectors.nativeDiagnostics,
           #available(iOS 14.0, macOS 12.0, *) {
            installMetricKitCollector()
        }
        #endif
    }

    // MARK: - Errors

    /// Capture a fatal signal, and report it on the NEXT launch.
    ///
    /// A crash handler cannot deliver its own crash: the process is already
    /// unwinding and a network round trip will not complete. So the handler does
    /// the only thing that is safe in that context — write the details to disk —
    /// and the next launch picks them up and sends them as a `native-crash`.
    ///
    /// The handler itself is deliberately tiny and allocation-free where it can
    /// be. Anything more ambitious inside a signal handler risks deadlocking on
    /// a lock the crashing thread already holds, which converts a reported crash
    /// into a hang.
    private func installErrorCollector() {
        drainPendingCrash()

        // `NSSetUncaughtExceptionHandler` takes a C function pointer, so one
        // process-wide handler is shared by all active logger instances.
        registerCleanup(CrumbtrailExceptionChain.install())
    }

    /// Read and clear anything the previous launch's crash handler left behind.
    private func drainPendingCrash() {
        guard let pending = CrumbtrailCrashStore.readPending() else { return }
        CrumbtrailCrashStore.clearPending()
        addEvent(
            kind: .nativeCrash,
            data: .object(compacting: [
                "msg": .string(
                    crumbtrailRedactedDiagnosticText(pending.message, maxCharacters: 1_024)
                        ?? "uncaught exception"
                ),
                "stk": pending.stack
                    .flatMap { crumbtrailRedactedDiagnosticText($0) }
                    .map(JSONValue.string),
                "signal": pending.signal
                    .flatMap { crumbtrailRedactedDiagnosticText($0, maxCharacters: 128) }
                    .map(JSONValue.string),
                "source": .string("previous-launch"),
            ])
        )
    }

    private func recordNativeHang(_ hang: CrumbtrailNativeHang) -> Bool {
        addEvent(
            kind: .nativeHang,
            data: .object(compacting: [
                "source": .string("main-thread"),
                "thresholdMs": .int(hang.thresholdMs),
                "observedDurationMs": .int(hang.observedDurationMs),
                "recovered": .bool(hang.recovered),
                "previousLaunch": .bool(hang.previousLaunch),
                "stk": hang.stack
                    .flatMap { crumbtrailRedactedDiagnosticText($0) }
                    .map(JSONValue.string),
            ])
        )
    }

    private func recordNativeCrash(_ crash: CrumbtrailNativeCrash) {
        addEvent(
            kind: .nativeCrash,
            data: .object(compacting: [
                "msg": .string(
                    crumbtrailRedactedDiagnosticText(crash.message, maxCharacters: 1_024)
                        ?? "MetricKit crash"
                ),
                "stk": crash.stack
                    .flatMap { crumbtrailRedactedDiagnosticText($0) }
                    .map(JSONValue.string),
                "signal": crash.signal
                    .flatMap { crumbtrailRedactedDiagnosticText($0, maxCharacters: 128) }
                    .map(JSONValue.string),
                "source": .string("previous-launch"),
                "at": crash.at.map(JSONValue.int),
            ])
        )
    }

    #if canImport(UIKit) && !os(macOS)

    // MARK: - Lifecycle

    /// Foreground and background transitions.
    ///
    /// Apple platforms can suspend timers, drop sockets, or kill the process
    /// while the app is backgrounded. This separates those transitions from
    /// active hangs.
    private func installLifecycleCollector() {
        let pendingHangStore = ApplicationSupportPendingHangStore()
        let pendingHangDrainScheduler: CrumbtrailDispatchWatchdogScheduler?
        if config.collectors.nativeDiagnostics || config.collectors.nativeWatchdog {
            let scheduler = CrumbtrailDispatchWatchdogScheduler()
            pendingHangDrainScheduler = scheduler
            scheduler.postToBackground { [weak self] in
                _ = drainPendingHang(pendingHangStore) { [weak self] hang in
                    self?.recordNativeHang(hang) ?? false
                }
                scheduler.shutdown()
            }
        } else {
            pendingHangDrainScheduler = nil
        }
        let watchdog: CrumbtrailMainThreadWatchdog? = config.collectors.nativeWatchdog
            ? CrumbtrailMainThreadWatchdog(
                scheduler: CrumbtrailDispatchWatchdogScheduler(),
                handoff: pendingHangStore,
                onHang: { [weak self] hang in self?.recordNativeHang(hang) ?? false },
                isDebuggerAttached: CrumbtrailDebugger.isAttached
            )
            : nil

        let center = NotificationCenter.default
        let transitions: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "active"),
            (UIApplication.willResignActiveNotification, "inactive"),
            (UIApplication.didEnterBackgroundNotification, "background"),
            (UIApplication.willEnterForegroundNotification, "foreground"),
            (UIApplication.willTerminateNotification, "terminate"),
        ]

        var tokens: [NSObjectProtocol] = []
        for (name, state) in transitions {
            let token = center.addObserver(
                forName: name, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                switch state {
                case "active", "foreground": watchdog?.resume()
                case "inactive", "background": watchdog?.pause()
                case "terminate": watchdog?.stop()
                default: break
                }
                if self.config.collectors.appLifecycle {
                    self.addEvent(
                        kind: .appLifecycle,
                        data: .object(compacting: [
                            "state": .string(state),
                            "source": .string("uiapplication"),
                        ])
                    )
                }
                // Backgrounding is the last reliable moment to deliver. iOS may
                // suspend the process seconds later and never resume it, so a
                // batch still sitting in the queue would be lost with the app.
                if state == "background" || state == "terminate" {
                    Task { await self.flush() }
                }
            }
            tokens.append(token)
        }

        // Memory pressure explains a class of crashes that leave no exception
        // at all: the OS simply kills the app, so the only surviving evidence
        // is that the warning arrived shortly before the session stopped.
        let memoryToken = center.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self,
                  self.config.collectors.appLifecycle || self.config.collectors.nativeDiagnostics
            else { return }
            self.addEvent(
                kind: .appLifecycle,
                data: .object(compacting: [
                    "state": .string("memory-warning"),
                    "source": .string("uiapplication"),
                ])
            )
        }
        tokens.append(memoryToken)

        registerCleanup {
            for token in tokens { center.removeObserver(token) }
            pendingHangDrainScheduler?.drain()
            pendingHangDrainScheduler?.shutdown()
            watchdog?.stop()
        }

        if UIApplication.shared.applicationState == .active {
            watchdog?.resume()
        }
    }

    /// Portrait and landscape, which reproduces a whole class of layout-only bugs.
    #if !os(tvOS)
    private func installOrientationCollector() {
        let center = NotificationCenter.default
        let token = center.addObserver(
            forName: UIDevice.orientationDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.addEvent(
                kind: .environment,
                data: .object(compacting: [
                    "kind": .string("orientation"),
                    "orientation": .string(
                        CrumbtrailOrientation.name(UIDevice.current.orientation)
                    ),
                ])
            )
        }
        registerCleanup { center.removeObserver(token) }
    }
    #endif

    #endif
}

#if canImport(MetricKit) && !os(tvOS) && !os(watchOS)
@available(iOS 14.0, macOS 12.0, *)
private extension Crumbtrail {
    func installMetricKitCollector() {
        let source = CrumbtrailSystemMetricKitSource()
        let collector = CrumbtrailMetricKitCollector(
            source: source,
            emitHang: { [weak self] hang in _ = self?.recordNativeHang(hang) },
            emitCrash: { [weak self] crash in self?.recordNativeCrash(crash) }
        )
        collector.start()
        registerCleanup { collector.stop() }
    }
}
#endif

#if canImport(UIKit) && !os(macOS) && !os(tvOS)
enum CrumbtrailOrientation {
    static func name(_ orientation: UIDeviceOrientation) -> String {
        switch orientation {
        case .portrait: return "portrait"
        case .portraitUpsideDown: return "portrait-upside-down"
        case .landscapeLeft: return "landscape-left"
        case .landscapeRight: return "landscape-right"
        case .faceUp: return "face-up"
        case .faceDown: return "face-down"
        default: return "unknown"
        }
    }
}
#endif
