import Foundation

/// Deny-biased redaction, applied before anything leaves the device.
///
/// The rule this enforces is the one from the wire contract: capture must never
/// be the reason a secret leaves the device. It is deny-biased on purpose —
/// a header or query parameter that *might* be a credential is dropped. Keeping
/// the shape while dropping the value preserves what an agent can act on
/// ("a 402 on POST /orders") and discards what it cannot use anyway.
public enum CrumbtrailRedaction {
    /// Header names that are always dropped, whatever they contain.
    static let deniedHeaderNames: Set<String> = [
        "authorization", "cookie", "setcookie", "proxyauthorization",
        "wwwauthenticate", "xapikey", "xauthtoken", "xcsrftoken",
    ]

    /// Substrings that condemn a header or query key on sight.
    static let deniedNameTokens = [
        "token", "secret", "key", "password", "passwd", "auth", "credential",
        "session", "signature", "bearer",
    ]

    /// Placeholder written in place of a redacted value.
    public static let placeholder = "[REDACTED]"

    /// Lowercase and strip non-alphanumerics, so `X-API_Key`, `x-api-key` and
    /// `xApiKey` all compact to the same token and cannot slip through on
    /// spelling alone.
    static func compact(_ name: String) -> String {
        name.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// Should a header with this name have its value dropped?
    public static func isDeniedHeader(_ name: String) -> Bool {
        let compacted = compact(name)
        if deniedHeaderNames.contains(compacted) { return true }
        return deniedNameTokens.contains { compacted.contains($0) }
    }

    /// Redact a header dictionary, preserving which headers were present.
    ///
    /// The *names* are kept because "the request carried an Authorization
    /// header" is diagnostic and harmless; only the value is dangerous.
    public static func redactHeaders(_ headers: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in headers {
            result[name] = isDeniedHeader(name) ? placeholder : value
        }
        return result
    }

    /// Strip credentials and credential-shaped query values from a URL.
    ///
    /// Three things get removed: userinfo (`https://user:pass@host`), any query
    /// value whose key looks like a credential, and the fragment — which is
    /// where single-page apps routinely park access tokens after an OAuth
    /// redirect.
    ///
    /// `URLComponents` is far more permissive than it looks: it happily accepts
    /// arbitrary junk, percent-encodes it, and reports success, so "did it
    /// parse?" is not a safety check. Two guards follow from that:
    ///
    ///   - A string that fails even that lenient parse becomes the placeholder.
    ///   - A string with no scheme or no host is not a URL this redactor can
    ///     reason about, so only its path survives. Query and fragment are
    ///     dropped wholesale rather than scanned, because the key-name heuristic
    ///     below is only trustworthy on something genuinely URL-shaped.
    public static func redactURL(_ raw: String) -> String {
        guard var components = URLComponents(string: raw) else { return placeholder }

        guard components.scheme != nil, let host = components.host, !host.isEmpty
        else {
            let path = components.percentEncodedPath
            return path.isEmpty ? placeholder : path
        }

        components.user = nil
        components.password = nil
        components.fragment = nil

        if let items = components.queryItems {
            components.queryItems = items.map { item in
                let compacted = compact(item.name)
                let denied = deniedNameTokens.contains { compacted.contains($0) }
                return denied
                    ? URLQueryItem(name: item.name, value: placeholder)
                    : item
            }
        }

        return components.string ?? placeholder
    }
}
