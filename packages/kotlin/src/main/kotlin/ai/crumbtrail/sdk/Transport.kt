package ai.crumbtrail.sdk

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

/** Why a batch did not arrive. */
sealed class CrumbtrailDeliveryException(message: String) : Exception(message) {
    abstract val eventCount: Int

    /** No response at all. Worth retrying. */
    data class Unreachable(override val eventCount: Int) :
        CrumbtrailDeliveryException("capture endpoint unreachable for $eventCount event(s)")

    /**
     * The server answered and refused. Retrying the identical batch would be
     * refused identically, so the caller declares a capture gap instead.
     */
    data class Refused(val status: Int, override val eventCount: Int) :
        CrumbtrailDeliveryException("capture endpoint rejected $eventCount event(s) with $status")
}

/** Where captured events go. */
interface CrumbtrailTransport {
    fun startSession(id: String, metadata: JsonValue)
    fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>)
    fun endSession(id: String)
}

/** Minimal seam over HTTP, so tests can assert exact bytes without a server. */
interface CrumbtrailHttpClient {
    /** @return the HTTP status. Throws [IOException] when there was no response. */
    fun post(url: String, headers: Map<String, String>, body: ByteArray): Int
}

/**
 * `HttpURLConnection` rather than OkHttp.
 *
 * OkHttp is the better client, and it is also already in most Android apps at
 * some specific version. A telemetry SDK that pins its own would force a version
 * conflict on the host for no benefit the host asked for. `HttpURLConnection` is
 * in the platform, ships nothing, and is more than adequate for posting batches.
 */
class DefaultHttpClient(
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 15_000,
) : CrumbtrailHttpClient {
    override fun post(url: String, headers: Map<String, String>, body: ByteArray): Int {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            connection.outputStream.use { it.write(body) }
            return connection.responseCode
        } finally {
            connection.disconnect()
        }
    }
}

/** HTTP transport implementing `docs/specs/native-sdk-wire-contract.md`. */
class CrumbtrailHttpTransport(
    endpoint: String,
    authToken: String? = null,
    private val client: CrumbtrailHttpClient = DefaultHttpClient(),
) : CrumbtrailTransport {
    // Trailing slashes would produce `//api/events`, which some gateways treat
    // as a distinct, unrouted path.
    private val endpoint = endpoint.trimEnd('/')

    // An empty token is not a token: sending the header with an empty value
    // reads to the server as a malformed credential rather than as none.
    private val authToken = authToken?.takeIf { it.isNotEmpty() }

    private val headers: Map<String, String>
        get() = buildMap {
            put("Content-Type", "application/json")
            authToken?.let { put("X-Crumbtrail-Auth", it) }
        }

    override fun startSession(id: String, metadata: JsonValue) {
        val body = JsonValue.of("sessionId" to JsonValue.Str(id), "metadata" to metadata)
        // Best effort: a session that fails to announce itself still captures,
        // and ingest creates it lazily from the first batch.
        runCatching { client.post("$endpoint/api/session/start", headers, body.toJson().toByteArray()) }
    }

    override fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>) {
        if (events.isEmpty()) return
        val body = JsonValue.of(
            "sessionId" to JsonValue.Str(sessionId),
            "events" to JsonValue.Arr(events.map { it.toJson() }),
        )
        val status = try {
            client.post("$endpoint/api/events", headers, body.toJson().toByteArray())
        } catch (_: Exception) {
            throw CrumbtrailDeliveryException.Unreachable(events.size)
        }
        // The whole reason this throws. A 413 or 429 is a perfectly normal
        // response, so an SDK that only catches exceptions counts a refusal as a
        // delivery, drops the batch, and reports a session indistinguishable
        // from one where nothing happened.
        if (status !in 200..299) {
            throw CrumbtrailDeliveryException.Refused(status, events.size)
        }
    }

    override fun endSession(id: String) {
        val body = JsonValue.of("sessionId" to JsonValue.Str(id))
        runCatching { client.post("$endpoint/api/session/end", headers, body.toJson().toByteArray()) }
    }
}
