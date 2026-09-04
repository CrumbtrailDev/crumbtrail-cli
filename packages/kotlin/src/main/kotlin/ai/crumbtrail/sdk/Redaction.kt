package ai.crumbtrail.sdk

import java.net.URI

/**
 * Deny-biased redaction, applied before anything leaves the device.
 *
 * Same rules as the Swift and Dart SDKs, and held to the same fixtures: capture
 * must never be the reason a secret leaves the device. Deny-biased on purpose —
 * a header or query key that *might* be a credential is dropped. Keeping the
 * shape while dropping the value preserves what an agent can act on and discards
 * what it could not use anyway.
 */
object CrumbtrailRedaction {
    const val PLACEHOLDER = "[REDACTED]"

    private val deniedHeaderNames = setOf(
        "authorization", "cookie", "setcookie", "proxyauthorization",
        "wwwauthenticate", "xapikey", "xauthtoken", "xcsrftoken",
    )

    private val deniedNameTokens = listOf(
        "token", "secret", "key", "password", "passwd", "auth", "credential",
        "session", "signature", "bearer",
    )

    /**
     * Lowercase and strip non-alphanumerics, so `X-API_Key`, `x-api-key` and
     * `xApiKey` compact to one token and cannot slip through on spelling.
     */
    fun compact(name: String): String =
        name.lowercase().filter { it.isLetterOrDigit() }

    fun isDeniedHeader(name: String): Boolean {
        val decoded = try {
                java.net.URLDecoder.decode(name, "UTF-8")
            } catch (_: IllegalArgumentException) {
                return PLACEHOLDER
            }
            if (decoded.contains('\uFFFD')) return PLACEHOLDER
            val compacted = compact(decoded)
        return compacted in deniedHeaderNames ||
            deniedNameTokens.any { compacted.contains(it) }
    }

    /**
     * Redact header values, keeping the names.
     *
     * "The request carried an Authorization header" is diagnostic and harmless.
     * Only the value is dangerous.
     */
    fun redactHeaders(headers: Map<String, String>): Map<String, String> =
        headers.mapValues { (name, value) ->
            if (isDeniedHeader(name)) PLACEHOLDER else value
        }

    /**
     * Strip credentials and credential-shaped query values from a URL.
     *
     * Removes userinfo (`https://user:pass@host`), the fragment — where
     * single-page apps park access tokens after an OAuth redirect — and any
     * query value whose key looks like a credential.
     *
     * Anything without a scheme and host keeps only its path. `URI` is lenient,
     * so "did it parse" is not a safety check; the query-key heuristic is only
     * trustworthy on something genuinely URL-shaped, and everything else has its
     * query dropped wholesale rather than scanned.
     */
    fun redactUrl(raw: String): String {
        if (raw.isEmpty()) return PLACEHOLDER
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return PLACEHOLDER
        }

        val scheme = uri.scheme
        val host = uri.host
        if (scheme == null || host.isNullOrEmpty()) {
            val path = uri.rawPath ?: raw.substringBefore('?').substringBefore('#')
            return path.ifEmpty { PLACEHOLDER }
        }

        val redactedQuery = uri.rawQuery?.split('&')?.joinToString("&") { pair ->
            val name = pair.substringBefore('=')
            val decoded = try {
                java.net.URLDecoder.decode(name, "UTF-8")
            } catch (_: IllegalArgumentException) {
                return PLACEHOLDER
            }
            if (decoded.contains('\uFFFD')) return PLACEHOLDER
            val compacted = compact(decoded)
            if (deniedNameTokens.any { compacted.contains(it) }) "$name=$PLACEHOLDER"
            else pair
        }

        return buildString {
            append(scheme).append("://").append(host)
            if (uri.port != -1) append(':').append(uri.port)
            append(uri.rawPath ?: "")
            if (!redactedQuery.isNullOrEmpty()) append('?').append(redactedQuery)
            // Fragment deliberately never re-appended.
        }
    }
}
