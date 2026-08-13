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
    nonisolated(unsafe) static var previous:
        (@convention(c) (NSException) -> Void)?
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
        if config.collectors.appLifecycle { installLifecycleCollector() }
        if config.collectors.navigation { installOrientationCollector() }
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

        // `NSSetUncaughtExceptionHandler` takes a C function pointer, which
        // cannot carry captured context — so the previously installed handler
        // is parked in static storage and the closure below captures nothing.
        // Chaining to it is not optional: an app using a crash reporter already
        // installed one, and replacing it outright would silently disable their
        // crash reporting the moment they add Crumbtrail.
        CrumbtrailExceptionChain.previous = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { exception in
            CrumbtrailCrashStore.writePending(
                message: exception.reason ?? exception.name.rawValue,
                stack: exception.callStackSymbols.joined(separator: "\n"),
                signal: exception.name.rawValue
            )
            CrumbtrailExceptionChain.previous?(exception)
        }
        registerCleanup {
            NSSetUncaughtExceptionHandler(CrumbtrailExceptionChain.previous)
            CrumbtrailExceptionChain.previous = nil
        }
    }

    /// Read and clear anything the previous launch's crash handler left behind.
    private func drainPendingCrash() {
        guard let pending = CrumbtrailCrashStore.readPending() else { return }
        CrumbtrailCrashStore.clearPending()
        addEvent(
            kind: .nativeCrash,
            data: .object(compacting: [
                "msg": .string(pending.message),
                "stk": pending.stack.map(JSONValue.string),
                "signal": pending.signal.map(JSONValue.string),
                "source": .string("previous-launch"),
            ])
        )
    }

    #if canImport(UIKit) && !os(macOS)

    // MARK: - Lifecycle

    /// Foreground and background transitions.
    ///
    /// This is load-bearing evidence on a phone in a way it never is on desktop
    /// web: the OS suspends timers, drops sockets, and may kill the process. A
    /// request that "hung" is usually a request whose app was suspended
    /// mid-flight, and only this track separates the two.
    private func installLifecycleCollector() {
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
                self.addEvent(
                    kind: .appLifecycle,
                    data: .object(compacting: [
                        "state": .string(state),
                        "source": .string("uiapplication"),
                    ])
                )
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
            self?.addEvent(
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
        }
    }

    /// Portrait and landscape, which reproduces a whole class of layout-only bugs.
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
}

#if canImport(UIKit) && !os(macOS)
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
