import XCTest
@testable import Crumbtrail

/// Conformance against `test-fixtures/wire-contract/`.
///
/// The Kotlin and Dart SDKs run the equivalent of this file against the same
/// files. Changing a fixture therefore fails all three at once, which is the
/// only mechanism that reliably catches one SDK quietly renaming a field.
final class WireContractTests: XCTestCase {
    private let fixtureSDK = CrumbtrailSDKDescriptor(
        name: "crumbtrail-fixture", version: "0.0.0-fixture"
    )
    private let fixtureTimestamp: Int64 = 1_754_000_000_000
    private let fixtureCapabilities = ["app-lifecycle", "device-info"]

    private func event(
        _ kind: CrumbtrailEventKind,
        _ data: JSONValue,
        target: CrumbtrailTarget? = nil
    ) -> CrumbtrailEvent {
        CrumbtrailEvent(
            timestamp: fixtureTimestamp,
            kind: kind,
            data: data,
            platform: .ios,
            sdk: fixtureSDK,
            capabilities: fixtureCapabilities,
            target: target
        )
    }

    private func assertMatches(
        _ event: CrumbtrailEvent,
        fixture name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let encoded = try FixtureLoader.encodeToDictionary(event)
        let expected = try FixtureLoader.event(name)
        assertJSONEqual(encoded, expected, file: file, line: line)
    }

    func testFixturesAreReachable() throws {
        // If the loader's path arithmetic is wrong, every other test in this
        // file would pass vacuously against an empty fixture. Fail loudly here.
        let fixture = try FixtureLoader.event("net")
        XCTAssertEqual(fixture["k"] as? String, "net")
    }

    func testErrorEvent() throws {
        try assertMatches(
            event(.error, [
                "msg": "Unexpected nil while unwrapping an Optional value",
                "stk": "CrumbtrailDemo.CheckoutViewController.submit()\nCrumbtrailDemo.CheckoutViewController.tap()",
                "fatal": true,
                "source": "uncaught-exception",
            ]),
            fixture: "err"
        )
    }

    func testRejectionEvent() throws {
        try assertMatches(
            event(.rejection, [
                "msg": "The request timed out.",
                "stk": "CrumbtrailDemo.OrderService.load()",
                "source": "unhandled-async",
            ]),
            fixture: "rej"
        )
    }

    func testConsoleEvent() throws {
        try assertMatches(
            event(.console, [
                "lv": "err",
                "args": ["checkout failed", "{\"orderId\":42}"],
            ]),
            fixture: "con"
        )
    }

    func testNetworkEvent() throws {
        try assertMatches(
            event(.network, [
                "url": "https://api.example.com/v1/orders",
                "method": "POST",
                "status": 402,
                "ok": false,
                "dur": 318,
                "source": "urlsession",
            ]),
            fixture: "net"
        )
    }

    func testNetworkStatusEvent() throws {
        try assertMatches(
            event(.networkStatus, [
                "connected": false, "type": "none", "kind": "change",
            ]),
            fixture: "net-status"
        )
    }

    func testEnvironmentEvent() throws {
        try assertMatches(
            event(.environment, [
                "kind": "snapshot",
                "device": [
                    "model": "iPhone15,2",
                    "manufacturer": "Apple",
                    "os": "iOS",
                    "osVersion": "18.2",
                ],
                "app": ["id": "ai.crumbtrail.demo", "version": "1.4.0", "build": "204"],
                "battery": ["level": 0.42, "charging": false],
                "locale": "en-GB",
            ]),
            fixture: "env"
        )
    }

    func testNavigationEvent() throws {
        try assertMatches(
            event(.navigation, [
                "name": "CheckoutViewController",
                "path": "/checkout",
                "source": "navigation-controller",
            ]),
            fixture: "navigation"
        )
    }

    func testNavigationIntentEvent() throws {
        try assertMatches(
            event(.navigationIntent, ["action": "back", "source": "hardware-back"]),
            fixture: "nav-intent"
        )
    }

    func testAppLifecycleEvent() throws {
        try assertMatches(
            event(.appLifecycle, ["state": "background", "source": "app-lifecycle"]),
            fixture: "app-lifecycle"
        )
    }

    func testNativeCrashEvent() throws {
        try assertMatches(
            event(.nativeCrash, [
                "msg": "Fatal error: index out of range",
                "stk": "CrumbtrailDemo.CartView.item(at:)",
                "signal": "SIGABRT",
                "source": "previous-launch",
            ]),
            fixture: "native-crash"
        )
    }

    func testViewSnapshotEvent() throws {
        try assertMatches(
            event(.viewSnapshot, [
                "w": 393,
                "h": 852,
                "nodes": [
                    [
                        "role": "screen",
                        "componentName": "CheckoutViewController",
                        "bounds": ["x": 0, "y": 0, "width": 393, "height": 852],
                    ],
                    [
                        "role": "button",
                        "label": "Pay now",
                        "testID": "checkout-pay",
                        "bounds": ["x": 16, "y": 720, "width": 361, "height": 48],
                    ],
                ],
            ]),
            fixture: "view-snapshot"
        )
    }

    func testTargetDescriptor() throws {
        try assertMatches(
            event(
                .error,
                ["msg": "tap handler threw", "fatal": false, "source": "caught"],
                target: CrumbtrailTarget(
                    role: "button",
                    label: "Pay now",
                    testID: "checkout-pay",
                    componentName: "CheckoutButton",
                    routePath: "/checkout",
                    bounds: .init(x: 16, y: 720, width: 361, height: 48)
                )
            ),
            fixture: "target"
        )
    }

    // MARK: - Envelope invariants

    func testSchemaVersionIsAlwaysSent() throws {
        let encoded = try FixtureLoader.encodeToDictionary(event(.error, [:]))
        XCTAssertEqual(encoded["schemaVersion"] as? Int, 1)
    }

    func testPlatformIsAlwaysSent() throws {
        let encoded = try FixtureLoader.encodeToDictionary(event(.error, [:]))
        XCTAssertEqual(encoded["platform"] as? String, "ios")
    }

    func testEmptyCapabilitiesAreOmittedNotSentEmpty() throws {
        let bare = CrumbtrailEvent(
            timestamp: fixtureTimestamp, kind: .error, data: [:], sdk: fixtureSDK
        )
        let encoded = try FixtureLoader.encodeToDictionary(bare)
        XCTAssertNil(
            encoded["capabilities"],
            "an absent field and an empty array are different claims on the ingest side"
        )
    }

    func testTargetThatIdentifiesNothingIsDropped() throws {
        let event = CrumbtrailEvent(
            timestamp: fixtureTimestamp,
            kind: .error,
            data: [:],
            sdk: fixtureSDK,
            // Bounds only: names no element, costs bytes on every event.
            target: CrumbtrailTarget(bounds: .init(x: 0, y: 0, width: 1, height: 1))
        )
        let encoded = try FixtureLoader.encodeToDictionary(event)
        XCTAssertNil(encoded["target"])
    }

    func testTimestampIsMilliseconds() {
        // Seconds here would place every event in 1970 and break every
        // correlation the product depends on. 1e12 is the ms/s watershed.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        XCTAssertGreaterThan(now, 1_000_000_000_000)
    }
}
