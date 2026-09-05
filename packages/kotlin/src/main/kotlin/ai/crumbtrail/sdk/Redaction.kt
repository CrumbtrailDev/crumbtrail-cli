package ai.crumbtrail.sdk

import java.net.URI
import java.net.URLDecoder

/**
 * Deny-biased redaction, applied before anything leaves the device.
 *
 * Same rules as the Swift and Dart SDKs, and held to the same fixtures:
 * `test-fixtures/redaction/urls.json` is read by this SDK's tests and by the
 * Dart SDK's tests, so a rule that drifts in one language fails in both. Capture
 * must never be the reason a secret leaves the device. Deny-biased on purpose —
 * a header, a query key, a query value or a path segment that *might* be a
 * credential is dropped. Keeping the shape while dropping the value preserves
 * what an agent can act on and discards what it could not use anyway.
 *
 * The URL rules are a port of `packages/core/src/redaction.ts`, narrowed to what
 * a mobile SDK can carry: path segment redaction, sensitive preceder detection,
 * and token shape matching on query values. Key names alone were never enough,
 * because a REST API puts the value in the path (`/reset-password/<jwt>`) and a
 * redirect parameter puts a whole second URL inside one query value.
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
     * Path segments whose *next* segment is the value, not another route name.
     *
     * `/reset/<code>` and `/otp/<code>` are followed by the secret itself.
     * `/session/refresh` is followed by an endpoint name, which is why the plain
     * route word carve-out below exists and why `session` is absent from
     * [credentialPathPreceders].
     */
    private val sensitivePathPreceders = setOf(
        "code", "invite", "magic", "mfa", "otp", "passcode", "reset", "session",
        "token", "verify",
    )

    /** The subset that is *definitionally* followed by a value, so no carve-out. */
    private val credentialPathPreceders = setOf(
        "code", "invite", "magic", "mfa", "otp", "passcode", "reset", "token",
        "verify",
    )

    /**
     * A segment that is plainly a route name rather than a value.
     *
     * Without this, `/api/auth/whoami` reports its own endpoint as a secret and a
     * captured 401 names no endpoint at all. Deliberately narrow, because it
     * weakens a security control: short all-lowercase words, API version
     * segments, and three named protocol words. Anything with entropy — a token,
     * a hash, an id, a JWT, a uuid — fails at least one of those.
     */
    private val plainRouteWord = Regex("^(?:[a-z]{2,16}|v[0-9]{1,3})$")
    private val plainRouteProtocolWords = setOf("oauth1", "oauth2", "saml2")

    /**
     * Credential shapes, matched on the decoded value.
     *
     * The last two are generic length-and-charset rules. They cost some
     * legitimate long identifiers, which is the intended trade on a plane where
     * the SDK cannot ask the application what a value means.
     */
    private val tokenPatterns = listOf(
        Regex("""\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b""", RegexOption.IGNORE_CASE),
        Regex("""\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"""),
        Regex(
            """(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_.=-]{12,}""",
            RegexOption.IGNORE_CASE,
        ),
        Regex("""\b[A-Fa-f0-9]{32,}\b"""),
        Regex("""\b[A-Za-z0-9_-]{40,}\b"""),
    )

    private val uuidPattern =
        Regex("""^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$""", RegexOption.IGNORE_CASE)
    private val emailPattern = Regex("""[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}""")
    private val opaqueSegment = Regex("""^[A-Za-z0-9_-]{16,39}$""")
    private val versionOrYearPart = Regex("""^[A-Za-z]?[0-9]{1,4}$""")
    private val lettersOnly = Regex("""^[A-Za-z]+$""")
    private val vowel = Regex("""[aeiouy]""", RegexOption.IGNORE_CASE)

    /**
     * Lowercase and strip non-alphanumerics, so `X-API_Key`, `x-api-key` and
     * `xApiKey` compact to one token and cannot slip through on spelling.
     */
    fun compact(name: String): String =
        name.lowercase().filter { it.isLetterOrDigit() }

    fun isDeniedHeader(name: String): Boolean {
        val compacted = compact(name)
        return compacted in deniedHeaderNames ||
            deniedNameTokens.any { compacted.contains(it) }
    }

    private fun isDeniedName(name: String): Boolean {
        val compacted = compact(name)
        return deniedNameTokens.any { compacted.contains(it) }
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
     * Strip credentials, credential-shaped path segments and credential-shaped
     * query values from a URL.
     *
     * Removes userinfo (`https://user:pass@host`) and the fragment — where
     * single-page apps park access tokens after an OAuth redirect — then rewrites
     * the path and query segment by segment.
     *
     * Anything without a scheme and host keeps only its path. `URI` is lenient,
     * so "did it parse" is not a safety check; the query heuristics are only
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
            // The parser's own path, never a slice of the input: a
            // protocol-relative `//user:pass@host/path` carries userinfo that a
            // slice would hand straight back.
            val path = uri.path ?: uri.schemeSpecificPart ?: ""
            if (path.isEmpty()) return PLACEHOLDER
            return redactPath(path)
        }

        val beforeFragment = raw.substringBefore('#')
        val beforeQuery = beforeFragment.substringBefore('?')
        val rawQuery =
            if (beforeFragment.contains('?')) beforeFragment.substringAfter('?') else null

        return buildString {
            append(scheme).append("://").append(host)
            if (uri.port != -1) append(':').append(uri.port)
            append(redactPath(rawPathOf(beforeQuery)))
            if (!rawQuery.isNullOrEmpty()) append('?').append(redactQuery(rawQuery))
            // Fragment deliberately never re-appended.
        }
    }

    /**
     * The path exactly as written, taken from the input rather than the parser.
     *
     * The parser's accessors either decode (losing `%2F` against `/`) or, in
     * Dart, do not exist at all. Slicing the input is the one derivation both
     * SDKs can perform identically, which is what makes their output byte
     * comparable in `test-fixtures/redaction/urls.json`.
     */
    private fun rawPathOf(beforeQuery: String): String {
        val separator = beforeQuery.indexOf("://")
        if (separator < 0) return ""
        val slash = beforeQuery.indexOf('/', separator + 3)
        return if (slash < 0) "" else beforeQuery.substring(slash)
    }

    /** Percent-decode up to three times, leaving `+` alone. Unchanged on failure. */
    private fun decodeDeep(value: String): String {
        var output = value
        repeat(3) {
            val decoded = decodeOnce(output) ?: return output
            if (decoded == output) return output
            output = decoded
        }
        return output
    }

    /**
     * One percent-decode, or null when the input is not decodable.
     *
     * `+` is escaped first because `URLDecoder` reads it as a space from
     * `application/x-www-form-urlencoded`, while Dart and the browser leave it
     * alone. A replacement character means the bytes were not UTF-8, which is
     * indistinguishable from a deliberately mangled key, so it fails closed.
     */
    private fun decodeOnce(value: String): String? {
        val decoded = try {
            URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
        } catch (_: Exception) {
            return null
        }
        return if (decoded.contains('�')) null else decoded
    }

    private fun redactQuery(rawQuery: String): String =
        rawQuery.split('&').joinToString("&") { pair ->
            val name = pair.substringBefore('=')
            if (decodeOnce(name) == null) return@joinToString "$name=$PLACEHOLDER"
            if (isDeniedName(decodeDeep(name))) return@joinToString "$name=$PLACEHOLDER"
            if (!pair.contains('=')) return@joinToString pair
            val value = pair.substringAfter('=')
            if (value.isEmpty()) return@joinToString pair
            if (decodeOnce(value) == null) return@joinToString "$name=$PLACEHOLDER"
            if (carriesSecret(decodeDeep(value))) "$name=$PLACEHOLDER" else pair
        }

    /**
     * Rewrite a path one segment at a time, carrying the previous segment as
     * context: `/reset/<value>` is what makes `<value>` a secret, and nothing in
     * the segment itself says so.
     */
    private fun redactPath(path: String): String {
        if (path.isEmpty() || path == "/") return path
        var previous = ""
        return path.split('/').joinToString("/") { segment ->
            if (segment.isEmpty()) return@joinToString segment
            val decoded = decodeDeep(segment)
            val lower = decoded.lowercase()
            val redact =
                (isSensitivePreceder(previous) && !isPlainRouteWord(previous, lower)) ||
                    carriesSecret(decoded) ||
                    isSecretLikeSegment(decoded)
            previous = if (redact) PLACEHOLDER.lowercase() else lower
            if (redact) PLACEHOLDER else segment
        }
    }

    private fun isSensitivePreceder(previous: String): Boolean =
        previous in sensitivePathPreceders || isDeniedName(previous)

    private fun isPlainRouteWord(previous: String, component: String): Boolean =
        previous !in credentialPathPreceders &&
            (plainRouteWord.matches(component) || component in plainRouteProtocolWords)

    /**
     * Does this decoded value carry a credential, whatever its key said?
     *
     * Three ways it can. It is a credential shape outright (`Bearer sk-live-…`,
     * a JWT, a long hex run). It is an email address, which is the value a REST
     * API most often puts in a path segment. Or it is a whole second URL with its
     * own query string, which is how `?next=https%3A%2F%2Fx.com%3Ftoken%3D…`
     * smuggles a token past a check that only reads the outer key.
     */
    private fun carriesSecret(decoded: String): Boolean {
        if (tokenPatterns.any { it.containsMatchIn(decoded) }) return true
        if (emailPattern.containsMatchIn(decoded)) return true
        if (!decoded.contains('=')) return false
        return decoded.split('?', '&').any { part ->
            part.contains('=') && (
                isDeniedName(part.substringBefore('=')) ||
                    tokenPatterns.any { it.containsMatchIn(part.substringAfter('=')) }
                )
        }
    }

    /**
     * An opaque identifier sitting in a path with nothing around it to say what
     * it is: a uuid, or a length-and-charset run that does not read as words.
     *
     * The word test is what keeps `aurora-desk-lamp` and `winter-sale-2024`
     * readable while `sk_live_4eC39HqLyjWDarjt` and a raw hex id still redact.
     * Without it, a product slug and a secret of the same length were treated
     * identically and a session could not say which page a bug happened on.
     */
    private fun isSecretLikeSegment(segment: String): Boolean {
        if (uuidPattern.matches(segment)) return true
        if (!opaqueSegment.matches(segment)) return false
        return !isWordLikeSlug(segment)
    }

    private fun isWordLikeSlug(segment: String): Boolean {
        val parts = segment.split('-', '_')
        if (parts.isEmpty()) return false
        return parts.all { part ->
            when {
                part.isEmpty() -> false
                versionOrYearPart.matches(part) -> true
                !lettersOnly.matches(part) -> false
                else -> vowel.containsMatchIn(part)
            }
        }
    }
}
