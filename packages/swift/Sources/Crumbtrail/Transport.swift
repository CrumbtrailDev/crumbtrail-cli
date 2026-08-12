import Foundation

/// Why a batch did not arrive.
public enum CrumbtrailDeliveryError: Error, Equatable {
    /// The request produced no response at all. Worth retrying.
    case unreachable(eventCount: Int)
    /// The server answered and refused. Retrying the identical batch will be
    /// refused identically, so the caller records a capture gap instead.
    case refused(status: Int, eventCount: Int)

    public var eventCount: Int {
        switch self {
        case .unreachable(let count): return count
        case .refused(_, let count): return count
        }
    }
}

/// Where captured events go.
public protocol CrumbtrailTransport: AnyObject {
    func startSession(id: String, metadata: JSONValue) async
    func sendEvents(sessionId: String, events: [CrumbtrailEvent]) async throws
    func endSession(id: String) async
}

/// Minimal seam over `URLSession`, so tests can assert on the exact bytes and
/// headers without a live server.
public protocol CrumbtrailHTTPClient: Sendable {
    func post(url: URL, headers: [String: String], body: Data) async throws -> Int
}

/// Real network client. Returns the HTTP status; throws only when there was no
/// response at all.
public struct URLSessionHTTPClient: CrumbtrailHTTPClient {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func post(url: URL, headers: [String: String], body: Data) async throws -> Int {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        let (_, response) = try await session.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }
}

/// HTTP transport implementing `docs/specs/native-sdk-wire-contract.md`.
public final class CrumbtrailHTTPTransport: CrumbtrailTransport {
    private let endpoint: String
    private let authToken: String?
    private let client: CrumbtrailHTTPClient
    private let encoder: JSONEncoder

    public init(
        endpoint: String,
        authToken: String? = nil,
        client: CrumbtrailHTTPClient = URLSessionHTTPClient()
    ) {
        // Trailing slashes would produce `//api/events`, which some gateways
        // treat as a distinct, unrouted path.
        var trimmed = endpoint
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        self.endpoint = trimmed
        // An empty token is not a token. Sending the header with an empty value
        // reads to the server as a malformed credential rather than as none.
        self.authToken = (authToken?.isEmpty ?? true) ? nil : authToken
        self.client = client

        let encoder = JSONEncoder()
        // Sorted keys make the payload byte-stable, which is what lets the
        // conformance tests compare against a shared fixture at all.
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
    }

    private var headers: [String: String] {
        var result = ["Content-Type": "application/json"]
        if let authToken { result["X-Crumbtrail-Auth"] = authToken }
        return result
    }

    private func url(_ path: String) -> URL? {
        URL(string: endpoint + path)
    }

    public func startSession(id: String, metadata: JSONValue) async {
        let body = JSONValue.object([
            "sessionId": .string(id),
            "metadata": metadata,
        ])
        // Best effort: a session that fails to announce itself still captures,
        // and ingest creates it lazily from the first batch.
        _ = try? await send(path: "/api/session/start", value: body, eventCount: 0)
    }

    public func sendEvents(sessionId: String, events: [CrumbtrailEvent]) async throws {
        guard !events.isEmpty else { return }
        let body = EventBatch(sessionId: sessionId, events: events)
        guard let url = url("/api/events"), let data = try? encoder.encode(body) else {
            throw CrumbtrailDeliveryError.unreachable(eventCount: events.count)
        }
        let status: Int
        do {
            status = try await client.post(url: url, headers: headers, body: data)
        } catch {
            throw CrumbtrailDeliveryError.unreachable(eventCount: events.count)
        }
        // The whole reason this method throws. A 413 or 429 resolves happily on
        // most HTTP APIs, so an SDK that only catches thrown errors counts a
        // refusal as a delivery, drops the batch, and reports a session that is
        // indistinguishable from one where nothing happened.
        guard (200..<300).contains(status) else {
            throw CrumbtrailDeliveryError.refused(status: status, eventCount: events.count)
        }
    }

    public func endSession(id: String) async {
        let body = JSONValue.object(["sessionId": .string(id)])
        _ = try? await send(path: "/api/session/end", value: body, eventCount: 0)
    }

    @discardableResult
    private func send(path: String, value: JSONValue, eventCount: Int) async throws -> Int {
        guard let url = url(path), let data = try? encoder.encode(value) else {
            throw CrumbtrailDeliveryError.unreachable(eventCount: eventCount)
        }
        do {
            return try await client.post(url: url, headers: headers, body: data)
        } catch {
            throw CrumbtrailDeliveryError.unreachable(eventCount: eventCount)
        }
    }

    private struct EventBatch: Encodable {
        let sessionId: String
        let events: [CrumbtrailEvent]
    }
}
