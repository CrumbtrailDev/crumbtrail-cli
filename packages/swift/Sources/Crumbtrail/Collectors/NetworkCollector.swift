import Foundation

/// Captures HTTP traffic as a `URLProtocol`.
///
/// Two approaches exist for intercepting `URLSession` on iOS, and the choice
/// matters enough to record:
///
///   - **Method swizzling** on `URLSession` catches everything including
///     `URLSession.shared`, but it mutates a system class at runtime, breaks
///     unpredictably across OS releases, and has repeatedly drawn app-review
///     attention. A telemetry SDK that can break someone's release build is not
///     worth the extra coverage.
///   - **`URLProtocol`** is the documented, supported seam. It requires the host
///     to register it, which is a real limitation and is stated plainly in the
///     README rather than papered over.
///
/// This takes the second. It observes and never modifies: the request is replayed
/// through a private session untouched, and the response is passed straight back.
public final class CrumbtrailURLProtocol: URLProtocol, @unchecked Sendable {
    /// Marks a request as already-being-observed, so the replay below does not
    /// re-enter this protocol and recurse forever.
    private static let handledKey = "ai.crumbtrail.handled"

    /// Where observations go. Weak so registering the protocol cannot keep a
    /// stopped session alive.
    private static weak var logger: Crumbtrail?
    private static let lock = NSLock()

    private var dataTask: URLSessionDataTask?
    private var startedAt: Date?

    /// Start recording traffic into `logger`.
    ///
    /// The host must also register the protocol with whatever session it uses:
    /// `configuration.protocolClasses = [CrumbtrailURLProtocol.self] + existing`.
    /// `URLSession.shared` cannot be reconfigured, so traffic on it is not
    /// captured — a documented limit, not a silent one.
    public static func install(logger: Crumbtrail) {
        lock.lock()
        self.logger = logger
        lock.unlock()
        URLProtocol.registerClass(CrumbtrailURLProtocol.self)
    }

    public static func uninstall() {
        lock.lock()
        logger = nil
        lock.unlock()
        URLProtocol.unregisterClass(CrumbtrailURLProtocol.self)
    }

    private static var activeLogger: Crumbtrail? {
        lock.lock()
        defer { lock.unlock() }
        return logger
    }

    public override class func canInit(with request: URLRequest) -> Bool {
        // Only observe when a session is listening, only HTTP(S), and never a
        // request this protocol itself replayed.
        guard activeLogger != nil else { return false }
        guard URLProtocol.property(forKey: handledKey, in: request) == nil else {
            return false
        }
        guard let scheme = request.url?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    public override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    public override func startLoading() {
        startedAt = Date()

        let mutable = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: mutable)

        let session = URLSession(configuration: .default)
        let task = session.dataTask(with: mutable as URLRequest) {
            [weak self] data, response, error in
            guard let self else { return }
            self.record(response: response, error: error)

            if let error {
                self.client?.urlProtocol(self, didFailWithError: error)
                return
            }
            if let response {
                self.client?.urlProtocol(
                    self, didReceive: response, cacheStoragePolicy: .notAllowed
                )
            }
            if let data {
                self.client?.urlProtocol(self, didLoad: data)
            }
            self.client?.urlProtocolDidFinishLoading(self)
        }
        dataTask = task
        task.resume()
    }

    public override func stopLoading() {
        dataTask?.cancel()
        dataTask = nil
    }

    private func record(response: URLResponse?, error: Error?) {
        guard let logger = Self.activeLogger else { return }
        let duration = Int64((Date().timeIntervalSince(startedAt ?? Date())) * 1000)
        // The body is never read. Capturing it would be the single easiest way
        // for this SDK to become the reason a token or a card number leaves the
        // device, and the status plus timing is what an agent can act on anyway.
        logger.recordRequest(
            url: request.url?.absoluteString ?? "",
            method: request.httpMethod ?? "GET",
            status: (response as? HTTPURLResponse)?.statusCode,
            durationMs: duration,
            source: "urlprotocol",
            error: error.map { String(describing: $0) }
        )
    }
}
