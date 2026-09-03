import Foundation
import XCTest
@testable import Crumbtrail

private final class FakeWatchdogTask: CrumbtrailWatchdogTask {
    var cancelled = false
    func cancel() { cancelled = true }
}

private final class FakeWatchdogScheduler: CrumbtrailWatchdogScheduler {
    private struct Entry {
        let task: FakeWatchdogTask
        let action: () -> Void
    }

    private var scheduled: [Entry] = []
    private var main: [() -> Void] = []
    private(set) var shutdownCalled = false

    var activeScheduledCount: Int { scheduled.filter { !$0.task.cancelled }.count }

    @discardableResult
    func schedule(after seconds: TimeInterval, _ task: @escaping () -> Void) -> CrumbtrailWatchdogTask {
        let handle = FakeWatchdogTask()
        scheduled.append(Entry(task: handle, action: task))
        return handle
    }

    func postToMain(_ task: @escaping () -> Void) { main.append(task) }

    func shutdown() { shutdownCalled = true }

    func runNextScheduled() {
        let entry = scheduled.removeFirst()
        if !entry.task.cancelled { entry.action() }
    }

    func runMain() {
        while !main.isEmpty { main.removeFirst()() }
    }
}

private final class FakeMetricKitSource: CrumbtrailMetricKitSource {
    private var handler: (([Data]) -> Void)?
    private(set) var stopped = false

    func start(_ handler: @escaping ([Data]) -> Void) { self.handler = handler }
    func stop() { stopped = true; handler = nil }
    func send(_ data: Data) { handler?([data]) }
}

final class NativeDiagnosticsTests: XCTestCase {
    func testWatchdogPersistsAndEmitsOnRecovery() {
        let scheduler = FakeWatchdogScheduler()
        let handoff = MemoryPendingHangStore()
        var now: Int64 = 0
        var observations: [CrumbtrailNativeHang] = []
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: handoff,
            onHang: { observations.append($0) },
            now: { now },
            thresholdMs: 5_000,
            captureStack: { "main stack" }
        )

        XCTAssertEqual(watchdog.threshold, 5_000)
        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        XCTAssertEqual(handoff.read()?.observedDurationMs, 5_000)
        XCTAssertTrue(observations.isEmpty)

        now = 6_200
        scheduler.runMain()
        XCTAssertEqual(observations.count, 1)
        XCTAssertTrue(observations[0].recovered)
        XCTAssertFalse(observations[0].previousLaunch)
        XCTAssertEqual(observations[0].observedDurationMs, 6_200)
        XCTAssertNil(handoff.read())
    }

    func testWatchdogPauseAndDebuggerSuppressChecks() {
        let scheduler = FakeWatchdogScheduler()
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in },
            isDebuggerAttached: { true }
        )
        watchdog.start()
        XCTAssertEqual(scheduler.activeScheduledCount, 0)
        XCTAssertFalse(scheduler.shutdownCalled)

        let runningScheduler = FakeWatchdogScheduler()
        let running = CrumbtrailMainThreadWatchdog(
            scheduler: runningScheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in }
        )
        running.start()
        XCTAssertEqual(runningScheduler.activeScheduledCount, 1)
        running.pause()
        XCTAssertEqual(runningScheduler.activeScheduledCount, 0)
        running.stop()
        XCTAssertTrue(runningScheduler.shutdownCalled)
    }

    func testPreviousLaunchHandoffIsImportedOnce() {
        let store = MemoryPendingHangStore(
            hang: CrumbtrailPendingHang(
                thresholdMs: 5_000,
                observedDurationMs: 8_000,
                stack: "old stack",
                at: 1
            )
        )
        var observations: [CrumbtrailNativeHang] = []
        drainPendingHang(store, onHang: { observations.append($0) })
        drainPendingHang(store, onHang: { observations.append($0) })

        XCTAssertEqual(observations.count, 1)
        XCTAssertFalse(observations[0].recovered)
        XCTAssertTrue(observations[0].previousLaunch)
        XCTAssertNil(store.read())
    }

    func testUserDefaultsHandoffRoundTripsAndBoundsText() {
        let suite = "ai.crumbtrail.tests.native-diagnostics"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let store = UserDefaultsPendingHangStore(defaults: defaults, key: "hang")
        store.write(
            CrumbtrailPendingHang(
                thresholdMs: 5_000,
                observedDurationMs: 8_000,
                stack: String(repeating: "x", count: 20_000),
                at: 42
            )
        )
        let read = store.read()
        XCTAssertEqual(read?.at, 42)
        XCTAssertEqual(crumbtrailBoundedDiagnosticText(read?.stack)?.count, 8_192)
        store.clear()
        XCTAssertNil(store.read())
    }

    func testMetricKitSeamImportsOnlyCrashAndHangContracts() throws {
        let source = FakeMetricKitSource()
        var hangs: [CrumbtrailNativeHang] = []
        var crashes: [CrumbtrailNativeCrash] = []
        let collector = CrumbtrailMetricKitCollector(
            source: source,
            emitHang: { hangs.append($0) },
            emitCrash: { crashes.append($0) }
        )
        collector.start()
        let payload: [String: Any] = [
            "hangDiagnostics": [[
                "hangDuration": "PT7.42S",
                "callStackTree": ["callStackRootFrames": [["symbol": "Checkout.submit()"]]],
            ]],
            "crashDiagnostics": [[
                "terminationReason": "fatal access",
                "signal": "SIGABRT",
                "callStackTree": ["callStackRootFrames": [["symbol": "Checkout.tap()"]]],
            ]],
            "metrics": [["name": "ignored"]],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        source.send(data)

        XCTAssertEqual(hangs.count, 1)
        XCTAssertEqual(hangs[0].observedDurationMs, 7_420)
        XCTAssertTrue(hangs[0].previousLaunch)
        XCTAssertEqual(hangs[0].stack, "Checkout.submit()")
        XCTAssertEqual(crashes.count, 1)
        XCTAssertEqual(crashes[0].message, "fatal access")
        XCTAssertEqual(crashes[0].signal, "SIGABRT")
        XCTAssertEqual(crashes[0].stack, "Checkout.tap()")

        collector.stop()
        XCTAssertTrue(source.stopped)
    }
}
