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
    private var background: [() -> Void] = []
    private(set) var shutdownCalled = false

    var activeScheduledCount: Int { scheduled.filter { !$0.task.cancelled }.count }

    @discardableResult
    func schedule(after seconds: TimeInterval, _ task: @escaping () -> Void) -> CrumbtrailWatchdogTask {
        let handle = FakeWatchdogTask()
        scheduled.append(Entry(task: handle, action: task))
        return handle
    }

    func postToMain(_ task: @escaping () -> Void) { main.append(task) }
    func postToBackground(_ task: @escaping () -> Void) { background.append(task) }
    func drain() { runBackground() }

    func shutdown() { shutdownCalled = true }

    func runNextScheduled() {
        let entry = scheduled.removeFirst()
        if !entry.task.cancelled { entry.action() }
    }

    func runMain() {
        while !main.isEmpty { main.removeFirst()() }
    }

    func runBackground() {
        while !background.isEmpty { background.removeFirst()() }
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
        var wallNow: Int64 = 100_000
        var observations: [CrumbtrailNativeHang] = []
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: handoff,
            onHang: { observations.append($0); return true },
            now: { now },
            wallNow: { wallNow },
            thresholdMs: 5_000,
            captureStack: { "main stack" }
        )

        XCTAssertEqual(watchdog.threshold, 5_000)
        watchdog.start()
        scheduler.runMain()
        now = 5_000
        wallNow = 90_000
        scheduler.runNextScheduled()
        XCTAssertEqual(handoff.read()?.observedDurationMs, 5_000)
        XCTAssertEqual(handoff.read()?.at, 90_000)
        XCTAssertEqual(handoff.read()?.startedAt, 85_000)
        XCTAssertTrue(observations.isEmpty)

        now = 6_200
        scheduler.runMain()
        XCTAssertTrue(observations.isEmpty)
        XCTAssertNotNil(handoff.read())
        scheduler.runBackground()
        XCTAssertEqual(observations.count, 1)
        XCTAssertTrue(observations[0].recovered)
        XCTAssertFalse(observations[0].previousLaunch)
        XCTAssertEqual(observations[0].observedDurationMs, 6_200)
        XCTAssertNil(handoff.read())
    }

    func testWatchdogStopDrainsRecoveryCleanup() {
        let scheduler = FakeWatchdogScheduler()
        let handoff = MemoryPendingHangStore()
        var now: Int64 = 0
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: handoff,
            onHang: { _ in true },
            now: { now }
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 5_100
        scheduler.runMain()
        XCTAssertNotNil(handoff.read())

        watchdog.stop()

        XCTAssertNil(handoff.read())
        XCTAssertTrue(scheduler.shutdownCalled)
    }

    func testWatchdogRetainsHandoffWhenCallbackRejects() {
        let scheduler = FakeWatchdogScheduler()
        let handoff = MemoryPendingHangStore()
        var now: Int64 = 0
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: handoff,
            onHang: { _ in false },
            now: { now }
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 5_100
        scheduler.runMain()
        scheduler.runBackground()

        XCTAssertNotNil(handoff.read())
    }

    func testWatchdogPauseAndDebuggerSuppressChecks() {
        let scheduler = FakeWatchdogScheduler()
        var attached = true
        let watchdog = CrumbtrailMainThreadWatchdog(
            scheduler: scheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in true },
            isDebuggerAttached: { attached }
        )
        watchdog.start()
        XCTAssertEqual(scheduler.activeScheduledCount, 1)
        XCTAssertFalse(scheduler.shutdownCalled)
        attached = false
        scheduler.runNextScheduled()
        XCTAssertEqual(scheduler.activeScheduledCount, 1)

        let attachedScheduler = FakeWatchdogScheduler()
        var dynamicallyAttached = false
        let attachedWatchdog = CrumbtrailMainThreadWatchdog(
            scheduler: attachedScheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in true },
            isDebuggerAttached: { dynamicallyAttached }
        )
        attachedWatchdog.start()
        attachedScheduler.runMain()
        dynamicallyAttached = true
        attachedScheduler.runNextScheduled()
        XCTAssertEqual(attachedScheduler.activeScheduledCount, 1)
        dynamicallyAttached = false
        attachedScheduler.runNextScheduled()
        XCTAssertEqual(attachedScheduler.activeScheduledCount, 1)

        let racedScheduler = FakeWatchdogScheduler()
        var racedAttached = true
        var pauseDuringPoll = false
        var racedWatchdog: CrumbtrailMainThreadWatchdog!
        racedWatchdog = CrumbtrailMainThreadWatchdog(
            scheduler: racedScheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in true },
            isDebuggerAttached: {
                if pauseDuringPoll {
                    pauseDuringPoll = false
                    racedWatchdog.pause()
                }
                return racedAttached
            }
        )
        racedWatchdog.start()
        racedAttached = false
        pauseDuringPoll = true
        racedScheduler.runNextScheduled()
        XCTAssertEqual(racedScheduler.activeScheduledCount, 0)

        let runningScheduler = FakeWatchdogScheduler()
        let running = CrumbtrailMainThreadWatchdog(
            scheduler: runningScheduler,
            handoff: MemoryPendingHangStore(),
            onHang: { _ in true }
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
        drainPendingHang(store, onHang: { observations.append($0); return true })
        drainPendingHang(store, onHang: { observations.append($0); return true })

        XCTAssertEqual(observations.count, 1)
        XCTAssertFalse(observations[0].recovered)
        XCTAssertTrue(observations[0].previousLaunch)
        XCTAssertNil(store.read())
    }

    func testPreviousLaunchHandoffRemainsWhenImportIsRejected() {
        let store = MemoryPendingHangStore(
            hang: CrumbtrailPendingHang(
                thresholdMs: 5_000,
                observedDurationMs: 8_000,
                stack: "old stack",
                at: 1
            )
        )

        XCTAssertFalse(drainPendingHang(store, onHang: { _ in false }))
        XCTAssertNotNil(store.read())
    }

    func testApplicationSupportHandoffRoundTripsAndBoundsText() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ai.crumbtrail.tests.native-diagnostics", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
        let url = directory.appendingPathComponent("hang.json")
        let store = ApplicationSupportPendingHangStore(fileURL: url)
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
        store.write(CrumbtrailPendingHang(thresholdMs: 5_000, observedDurationMs: 9_000, stack: "new", at: 43))
        XCTAssertEqual(store.read()?.at, 43)
        store.clear()
        XCTAssertNil(store.read())
    }

    func testApplicationSupportHandoffCleansOnlyBoundedStaleTemporaryReplacements() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ai.crumbtrail.tests.native-diagnostics-stale", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("hang.json")
        let temporaryDirectory = directory.appendingPathComponent(
            "crumbtrail-pending-hang-tmp", isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: temporaryDirectory, withIntermediateDirectories: true
        )
        let stale = temporaryDirectory.appendingPathComponent("hang.json.replacement-interrupted.tmp")
        let fresh = temporaryDirectory.appendingPathComponent("hang.json.replacement-active.tmp")
        let unrelated = temporaryDirectory.appendingPathComponent("other-file.interrupted.tmp")
        try Data("stale".utf8).write(to: stale)
        try Data("fresh".utf8).write(to: fresh)
        try Data("unrelated".utf8).write(to: unrelated)
        let old = Date(timeIntervalSinceNow: -2 * 24 * 60 * 60)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: unrelated.path)

        let store = ApplicationSupportPendingHangStore(fileURL: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))

        try Data("stale-again".utf8).write(to: stale)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
        _ = store.read()
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))

        for index in 0..<12 {
            let bounded = temporaryDirectory.appendingPathComponent(
                "hang.json.replacement-bounded.\(index).tmp"
            )
            try Data("stale-\(index)".utf8).write(to: bounded)
            try FileManager.default.setAttributes(
                [.modificationDate: old], ofItemAtPath: bounded.path
            )
        }
        _ = store.read()
        let remainingBounded = try FileManager.default.contentsOfDirectory(
            at: temporaryDirectory,
            includingPropertiesForKeys: nil,
            options: []
        ).filter {
            $0.lastPathComponent.hasPrefix("hang.json.replacement-bounded.")
                && $0.lastPathComponent.hasSuffix(".tmp")
        }
        XCTAssertEqual(remainingBounded.count, 4)

        try Data("stale-before-clear".utf8).write(to: stale)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
        store.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        try? FileManager.default.removeItem(at: directory)
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
