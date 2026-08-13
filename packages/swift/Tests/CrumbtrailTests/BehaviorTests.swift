import XCTest
@testable import Crumbtrail

// MARK: - Session

final class SessionResolverTests: XCTestCase {
    func testResumesAFreshSession() {
        let store = MemorySessionStore(
            session: PersistedSession(id: "sess-old", lastActivity: 1_000)
        )
        let resolved = CrumbtrailSessionResolver.resolve(
            store: store, idleMs: 5_000, now: 4_000, mint: { "sess-new" }
        )
        XCTAssertEqual(resolved.id, "sess-old")
        XCTAssertEqual(resolved.lastActivity, 4_000, "activity must be refreshed on resume")
    }

    func testMintsAFreshSessionOnceIdle() {
        // Resuming here would stitch today's bug onto last week's timeline.
        let store = MemorySessionStore(
            session: PersistedSession(id: "sess-old", lastActivity: 1_000)
        )
        let resolved = CrumbtrailSessionResolver.resolve(
            store: store, idleMs: 5_000, now: 99_000, mint: { "sess-new" }
        )
        XCTAssertEqual(resolved.id, "sess-new")
    }

    func testResumesExactlyAtTheIdleBoundary() {
        let store = MemorySessionStore(
            session: PersistedSession(id: "sess-old", lastActivity: 1_000)
        )
        let resolved = CrumbtrailSessionResolver.resolve(
            store: store, idleMs: 5_000, now: 6_000, mint: { "sess-new" }
        )
        XCTAssertEqual(resolved.id, "sess-old", "<= is the contract, not <")
    }

    func testMintsWhenNothingIsPersisted() {
        let store = MemorySessionStore()
        let resolved = CrumbtrailSessionResolver.resolve(
            store: store, idleMs: 5_000, now: 10, mint: { "sess-new" }
        )
        XCTAssertEqual(resolved.id, "sess-new")
        XCTAssertEqual(store.read()?.id, "sess-new", "the fresh id must be persisted")
    }

    func testMintedIdsAreDistinct() {
        let ids = (0..<50).map { _ in CrumbtrailSessionResolver.mintSessionId() }
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertTrue(ids.allSatisfy { $0.hasPrefix("ses_") })
    }

    func testCorruptPersistedDataStartsFreshRatherThanCrashing() {
        let defaults = UserDefaults(suiteName: "ai.crumbtrail.tests.corrupt")!
        defaults.removePersistentDomain(forName: "ai.crumbtrail.tests.corrupt")
        defaults.set(Data("not json".utf8), forKey: "ai.crumbtrail.session")

        let store = UserDefaultsSessionStore(defaults: defaults, key: "ai.crumbtrail.session")
        XCTAssertNil(store.read())
    }

    func testUserDefaultsStoreRoundTrips() {
        let defaults = UserDefaults(suiteName: "ai.crumbtrail.tests.roundtrip")!
        defaults.removePersistentDomain(forName: "ai.crumbtrail.tests.roundtrip")
        let store = UserDefaultsSessionStore(defaults: defaults, key: "k")

        store.write(PersistedSession(id: "sess-1", lastActivity: 42))
        XCTAssertEqual(store.read(), PersistedSession(id: "sess-1", lastActivity: 42))

        store.clear()
        XCTAssertNil(store.read())
    }
}

// MARK: - Transport

/// Records every request and answers with a scripted status.
private final class StubHTTPClient: CrumbtrailHTTPClient, @unchecked Sendable {
    struct Request {
        let url: URL
        let headers: [String: String]
        let body: Data
    }

    private let lock = NSLock()
    private var _requests: [Request] = []
    private let status: Int
    private let throwsError: Bool

    init(status: Int = 200, throwsError: Bool = false) {
        self.status = status
        self.throwsError = throwsError
    }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return _requests
    }

    func post(url: URL, headers: [String: String], body: Data) async throws -> Int {
        lock.lock()
        _requests.append(Request(url: url, headers: headers, body: body))
        lock.unlock()
        if throwsError { throw URLError(.notConnectedToInternet) }
        return status
    }
}

final class TransportTests: XCTestCase {
    private func makeEvent() -> CrumbtrailEvent {
        CrumbtrailEvent(
            timestamp: 1_754_000_000_000,
            kind: .error,
            data: ["msg": "boom"],
            sdk: CrumbtrailSDK.descriptor
        )
    }

    func testPostsEventsToTheContractPath() async throws {
        let client = StubHTTPClient()
        let transport = CrumbtrailHTTPTransport(
            endpoint: "https://api.crumbtrail.ai", authToken: "ctkey_abc", client: client
        )
        try await transport.sendEvents(sessionId: "sess-1", events: [makeEvent()])

        let request = try XCTUnwrap(client.requests.first)
        XCTAssertEqual(request.url.absoluteString, "https://api.crumbtrail.ai/api/events")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.headers["X-Crumbtrail-Auth"], "ctkey_abc")

        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.body) as? [String: Any]
        )
        XCTAssertEqual(body["sessionId"] as? String, "sess-1")
        XCTAssertEqual((body["events"] as? [Any])?.count, 1)
    }

    func testStripsTrailingSlashesFromTheEndpoint() async throws {
        let client = StubHTTPClient()
        let transport = CrumbtrailHTTPTransport(
            endpoint: "https://api.crumbtrail.ai///", client: client
        )
        try await transport.sendEvents(sessionId: "s", events: [makeEvent()])

        // `//api/events` is a distinct, unrouted path on some gateways.
        XCTAssertEqual(
            client.requests.first?.url.absoluteString,
            "https://api.crumbtrail.ai/api/events"
        )
    }

    func testOmitsTheAuthHeaderEntirelyWhenNoKeyIsSet() async throws {
        for token in [nil, ""] as [String?] {
            let client = StubHTTPClient()
            let transport = CrumbtrailHTTPTransport(
                endpoint: "https://api.crumbtrail.ai", authToken: token, client: client
            )
            try await transport.sendEvents(sessionId: "s", events: [makeEvent()])
            // An empty value reads as a malformed credential, not as none.
            XCTAssertNil(client.requests.first?.headers["X-Crumbtrail-Auth"])
        }
    }

    func testRefusalThrowsRatherThanCountingAsDelivery() async {
        for status in [400, 401, 413, 429, 500] {
            let client = StubHTTPClient(status: status)
            let transport = CrumbtrailHTTPTransport(
                endpoint: "https://api.crumbtrail.ai", client: client
            )
            do {
                try await transport.sendEvents(sessionId: "s", events: [makeEvent()])
                XCTFail("\(status) must not be treated as a delivery")
            } catch let error as CrumbtrailDeliveryError {
                XCTAssertEqual(error, .refused(status: status, eventCount: 1))
            } catch {
                XCTFail("unexpected error \(error)")
            }
        }
    }

    func testNetworkFailureIsReportedAsUnreachable() async {
        let client = StubHTTPClient(throwsError: true)
        let transport = CrumbtrailHTTPTransport(
            endpoint: "https://api.crumbtrail.ai", client: client
        )
        do {
            try await transport.sendEvents(sessionId: "s", events: [makeEvent()])
            XCTFail("expected a throw")
        } catch let error as CrumbtrailDeliveryError {
            XCTAssertEqual(error, .unreachable(eventCount: 1))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testEmptyBatchSendsNothing() async throws {
        let client = StubHTTPClient()
        let transport = CrumbtrailHTTPTransport(
            endpoint: "https://api.crumbtrail.ai", client: client
        )
        try await transport.sendEvents(sessionId: "s", events: [])
        XCTAssertTrue(client.requests.isEmpty)
    }

    func testSessionStartAndEndUseTheContractPaths() async {
        let client = StubHTTPClient()
        let transport = CrumbtrailHTTPTransport(
            endpoint: "https://api.crumbtrail.ai", client: client
        )
        await transport.startSession(id: "sess-1", metadata: ["service": "app"])
        await transport.endSession(id: "sess-1")

        XCTAssertEqual(
            client.requests.map(\.url.path),
            ["/api/session/start", "/api/session/end"]
        )
    }
}

// MARK: - Queue

final class EventQueueTests: XCTestCase {
    private func event(_ ms: Int64) -> CrumbtrailEvent {
        CrumbtrailEvent(
            timestamp: ms, kind: .error, data: [:], sdk: CrumbtrailSDK.descriptor
        )
    }

    func testDropsOldestOnceFull() {
        let queue = CrumbtrailEventQueue(capacity: 3)
        for i in 1...5 { queue.append(event(Int64(i))) }

        // Growing without bound would let a hot logging loop get the app killed
        // for memory — the SDK becoming the crash it was installed to explain.
        XCTAssertEqual(queue.count, 3)
        XCTAssertEqual(queue.dropped, 2)
        XCTAssertEqual(queue.drain().map(\.timestamp), [3, 4, 5])
    }

    func testDropsAreCountedNotSilent() {
        let queue = CrumbtrailEventQueue(capacity: 1)
        for i in 1...10 { queue.append(event(Int64(i))) }
        // A session that quietly lost events reads as a session where nothing
        // happened, which is the exact failure this SDK exists to prevent.
        XCTAssertEqual(queue.dropped, 9)
    }

    func testDrainEmptiesTheQueue() {
        let queue = CrumbtrailEventQueue(capacity: 10)
        queue.append(event(1))
        XCTAssertEqual(queue.drain().count, 1)
        XCTAssertEqual(queue.count, 0)
        XCTAssertTrue(queue.drain().isEmpty)
    }

    func testRequeuePreservesChronologicalOrder() {
        let queue = CrumbtrailEventQueue(capacity: 10)
        queue.append(event(3))
        // A retried batch appended at the back would sit after events that
        // happened later, inventing causality that never occurred.
        queue.requeue([event(1), event(2)])
        XCTAssertEqual(queue.drain().map(\.timestamp), [1, 2, 3])
    }

    func testRequeueRespectsCapacity() {
        let queue = CrumbtrailEventQueue(capacity: 2)
        queue.append(event(9))
        queue.requeue([event(1), event(2), event(3)])
        XCTAssertEqual(queue.count, 2)
        XCTAssertEqual(queue.drain().map(\.timestamp), [3, 9])
    }

    func testConcurrentAppendsDoNotLoseEvents() {
        let queue = CrumbtrailEventQueue(capacity: 10_000)
        DispatchQueue.concurrentPerform(iterations: 1_000) { i in
            queue.append(self.event(Int64(i)))
        }
        XCTAssertEqual(queue.count, 1_000)
    }
}

// MARK: - Redaction

final class RedactionTests: XCTestCase {
    func testDropsCredentialHeaderValuesButKeepsTheNames() {
        let redacted = CrumbtrailRedaction.redactHeaders([
            "Authorization": "Bearer secret",
            "Cookie": "session=abc",
            "X-API-Key": "abc123",
            "Content-Type": "application/json",
            "Accept": "application/json",
        ])
        // The name is diagnostic and harmless; only the value is dangerous.
        XCTAssertEqual(redacted["Authorization"], "[REDACTED]")
        XCTAssertEqual(redacted["Cookie"], "[REDACTED]")
        XCTAssertEqual(redacted["X-API-Key"], "[REDACTED]")
        XCTAssertEqual(redacted["Content-Type"], "application/json")
        XCTAssertEqual(redacted["Accept"], "application/json")
    }

    func testHeaderMatchingIgnoresSpellingAndPunctuation() {
        for spelling in ["X-API_Key", "x-api-key", "xApiKey", "X_API_KEY"] {
            XCTAssertTrue(
                CrumbtrailRedaction.isDeniedHeader(spelling),
                "\(spelling) must not slip through on spelling alone"
            )
        }
    }

    func testStripsUserinfoFromURLs() {
        let redacted = CrumbtrailRedaction.redactURL("https://user:pass@api.example.com/v1")
        XCTAssertFalse(redacted.contains("user"))
        XCTAssertFalse(redacted.contains("pass"))
        XCTAssertTrue(redacted.contains("api.example.com"))
    }

    func testRedactsCredentialShapedQueryValues() {
        let redacted = CrumbtrailRedaction.redactURL(
            "https://api.example.com/v1?page=2&access_token=abc123&q=shoes"
        )
        XCTAssertFalse(redacted.contains("abc123"))
        // The rest of the query is what makes the request diagnosable.
        XCTAssertTrue(redacted.contains("page=2"))
        XCTAssertTrue(redacted.contains("q=shoes"))
    }

    func testDropsTheFragmentWhereOAuthTokensLand() {
        let redacted = CrumbtrailRedaction.redactURL(
            "https://app.example.com/callback#access_token=abc123"
        )
        XCTAssertFalse(redacted.contains("abc123"))
    }

    func testNonURLStringsKeepOnlyTheirPath() {
        // URLComponents accepts arbitrary junk and percent-encodes it, so
        // "did it parse" proves nothing. Anything without a scheme and host has
        // its query and fragment dropped wholesale rather than scanned, because
        // the key-name heuristic is only trustworthy on a real URL.
        XCTAssertEqual(
            CrumbtrailRedaction.redactURL("/v1/orders?access_token=abc123"),
            "/v1/orders"
        )
        XCTAssertEqual(CrumbtrailRedaction.redactURL(""), "[REDACTED]")
    }

    func testSchemelessStringsCannotLeakAQueryValue() {
        let redacted = CrumbtrailRedaction.redactURL("not a url?token=abc123")
        XCTAssertFalse(redacted.contains("abc123"))
    }
}
