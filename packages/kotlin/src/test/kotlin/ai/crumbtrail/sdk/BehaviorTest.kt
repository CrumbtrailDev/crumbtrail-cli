package ai.crumbtrail.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionResolverTest {
    @Test
    fun `resumes a fresh session and refreshes its activity`() {
        val store = MemorySessionStore(PersistedSession("sess-old", 1_000))
        val resolved = CrumbtrailSessionResolver.resolve(store, idleMs = 5_000, now = 4_000) { "sess-new" }
        assertEquals("sess-old", resolved.id)
        assertEquals(4_000, resolved.lastActivity)
    }

    @Test
    fun `mints a fresh session once idle`() {
        // Resuming here would stitch today's bug onto last week's timeline.
        val store = MemorySessionStore(PersistedSession("sess-old", 1_000))
        val resolved = CrumbtrailSessionResolver.resolve(store, idleMs = 5_000, now = 99_000) { "sess-new" }
        assertEquals("sess-new", resolved.id)
    }

    @Test
    fun `resumes exactly at the idle boundary`() {
        val store = MemorySessionStore(PersistedSession("sess-old", 1_000))
        val resolved = CrumbtrailSessionResolver.resolve(store, idleMs = 5_000, now = 6_000) { "sess-new" }
        assertEquals("sess-old", resolved.id, "<= is the contract, not <")
    }

    @Test
    fun `persists the freshly minted id`() {
        val store = MemorySessionStore()
        CrumbtrailSessionResolver.resolve(store, idleMs = 5_000, now = 10) { "sess-new" }
        assertEquals("sess-new", store.read()?.id)
    }

    @Test
    fun `minted ids are distinct and correctly prefixed`() {
        val ids = (1..50).map { CrumbtrailSessionResolver.mintSessionId() }
        assertEquals(ids.size, ids.toSet().size)
        assertTrue(ids.all { it.startsWith("ses_") })
    }
}

/** Records every request and answers with a scripted status. */
private class StubHttpClient(
    private val status: Int = 200,
    private val throwsError: Boolean = false,
) : CrumbtrailHttpClient {
    data class Request(val url: String, val headers: Map<String, String>, val body: String)

    val requests = mutableListOf<Request>()

    override fun post(url: String, headers: Map<String, String>, body: ByteArray): Int {
        requests.add(Request(url, headers, String(body)))
        if (throwsError) throw java.io.IOException("offline")
        return status
    }
}

class TransportTest {
    private fun event() = CrumbtrailEvent(
        timestamp = 1_754_000_000_000,
        kind = CrumbtrailEventKind.ERROR,
        data = JsonValue.of("msg" to JsonValue.Str("boom")),
        sdk = CrumbtrailSdk.descriptor,
    )

    @Test
    fun `posts events to the contract path with the auth header`() {
        val client = StubHttpClient()
        CrumbtrailHttpTransport("https://api.crumbtrail.ai", "ctkey_abc", client)
            .sendEvents("sess-1", listOf(event()))

        val request = client.requests.single()
        assertEquals("https://api.crumbtrail.ai/api/events", request.url)
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("ctkey_abc", request.headers["X-Crumbtrail-Auth"])
        assertTrue(request.body.contains("\"sessionId\":\"sess-1\""))
    }

    @Test
    fun `strips trailing slashes from the endpoint`() {
        val client = StubHttpClient()
        CrumbtrailHttpTransport("https://api.crumbtrail.ai///", client = client)
            .sendEvents("s", listOf(event()))
        // `//api/events` is a distinct, unrouted path on some gateways.
        assertEquals("https://api.crumbtrail.ai/api/events", client.requests.single().url)
    }

    @Test
    fun `omits the auth header entirely when no key is set`() {
        for (token in listOf(null, "")) {
            val client = StubHttpClient()
            CrumbtrailHttpTransport("https://api.crumbtrail.ai", token, client)
                .sendEvents("s", listOf(event()))
            // An empty value reads as a malformed credential, not as none.
            assertFalse(client.requests.single().headers.containsKey("X-Crumbtrail-Auth"))
        }
    }

    @Test
    fun `a refusal throws rather than counting as delivery`() {
        for (status in listOf(400, 401, 413, 429, 500)) {
            val client = StubHttpClient(status = status)
            val transport = CrumbtrailHttpTransport("https://api.crumbtrail.ai", client = client)
            val error = assertFailsWith<CrumbtrailDeliveryException.Refused> {
                transport.sendEvents("s", listOf(event()))
            }
            assertEquals(status, error.status)
            assertEquals(1, error.eventCount)
        }
    }

    @Test
    fun `a network failure is reported as unreachable`() {
        val client = StubHttpClient(throwsError = true)
        val transport = CrumbtrailHttpTransport("https://api.crumbtrail.ai", client = client)
        assertFailsWith<CrumbtrailDeliveryException.Unreachable> {
            transport.sendEvents("s", listOf(event()))
        }
    }

    @Test
    fun `an empty batch sends nothing`() {
        val client = StubHttpClient()
        CrumbtrailHttpTransport("https://api.crumbtrail.ai", client = client)
            .sendEvents("s", emptyList())
        assertTrue(client.requests.isEmpty())
    }

    @Test
    fun `session start and end use the contract paths`() {
        val client = StubHttpClient()
        val transport = CrumbtrailHttpTransport("https://api.crumbtrail.ai", client = client)
        transport.startSession("sess-1", JsonValue.of("service" to JsonValue.Str("app")))
        transport.endSession("sess-1")
        assertEquals(
            listOf(
                "https://api.crumbtrail.ai/api/session/start",
                "https://api.crumbtrail.ai/api/session/end",
            ),
            client.requests.map { it.url },
        )
    }
}

class EventQueueTest {
    private fun event(ms: Long) = CrumbtrailEvent(
        timestamp = ms,
        kind = CrumbtrailEventKind.ERROR,
        data = JsonValue.of(),
        sdk = CrumbtrailSdk.descriptor,
    )

    @Test
    fun `drops oldest once full and counts the drops`() {
        val queue = CrumbtrailEventQueue(capacity = 3)
        (1..5).forEach { queue.append(event(it.toLong())) }
        // Growing without bound would let a hot logging loop get the app killed
        // for memory — the SDK becoming the crash it was installed to explain.
        assertEquals(3, queue.size)
        assertEquals(2, queue.dropped)
        assertEquals(listOf(3L, 4L, 5L), queue.drain().map { it.timestamp })
    }

    @Test
    fun `drain empties the queue`() {
        val queue = CrumbtrailEventQueue(capacity = 10)
        queue.append(event(1))
        assertEquals(1, queue.drain().size)
        assertTrue(queue.drain().isEmpty())
    }

    @Test
    fun `requeue preserves chronological order`() {
        val queue = CrumbtrailEventQueue(capacity = 10)
        queue.append(event(3))
        // A retried batch appended at the back would sit after events that
        // happened later, inventing causality that never occurred.
        queue.requeue(listOf(event(1), event(2)))
        assertEquals(listOf(1L, 2L, 3L), queue.drain().map { it.timestamp })
    }

    @Test
    fun `requeue respects capacity`() {
        val queue = CrumbtrailEventQueue(capacity = 2)
        queue.append(event(9))
        queue.requeue(listOf(event(1), event(2), event(3)))
        assertEquals(listOf(3L, 9L), queue.drain().map { it.timestamp })
    }

    @Test
    fun `concurrent appends do not lose events`() {
        val queue = CrumbtrailEventQueue(capacity = 10_000)
        val threads = (1..8).map { worker ->
            Thread { (1..125).forEach { queue.append(event((worker * 1000 + it).toLong())) } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertEquals(1_000, queue.size)
    }
}

class RedactionTest {
    @Test
    fun `drops credential header values but keeps the names`() {
        val redacted = CrumbtrailRedaction.redactHeaders(
            mapOf(
                "Authorization" to "Bearer secret",
                "Cookie" to "session=abc",
                "X-API-Key" to "abc123",
                "Content-Type" to "application/json",
            )
        )
        // The name is diagnostic and harmless; only the value is dangerous.
        assertEquals("[REDACTED]", redacted["Authorization"])
        assertEquals("[REDACTED]", redacted["Cookie"])
        assertEquals("[REDACTED]", redacted["X-API-Key"])
        assertEquals("application/json", redacted["Content-Type"])
    }

    @Test
    fun `header matching ignores spelling and punctuation`() {
        for (spelling in listOf("X-API_Key", "x-api-key", "xApiKey", "X_API_KEY")) {
            assertTrue(
                CrumbtrailRedaction.isDeniedHeader(spelling),
                "$spelling must not slip through on spelling alone",
            )
        }
    }

    @Test
    fun `strips userinfo from urls`() {
        val redacted = CrumbtrailRedaction.redactUrl("https://user:pass@api.example.com/v1")
        assertFalse(redacted.contains("pass"))
        assertTrue(redacted.contains("api.example.com"))
    }

    @Test
    fun `redacts credential shaped query values but keeps the rest`() {
        val redacted = CrumbtrailRedaction.redactUrl(
            "https://api.example.com/v1?page=2&access_token=abc123&q=shoes"
        )
        assertFalse(redacted.contains("abc123"))
        // The rest of the query is what makes the request diagnosable.
        assertTrue(redacted.contains("page=2"))
        assertTrue(redacted.contains("q=shoes"))
    }

    @Test
    fun `drops the fragment where oauth tokens land`() {
        val redacted = CrumbtrailRedaction.redactUrl(
            "https://app.example.com/callback#access_token=abc123"
        )
        assertFalse(redacted.contains("abc123"))
    }

    @Test
    fun `strings without a scheme and host keep only their path`() {
        // URI is lenient, so "did it parse" proves nothing. The query-key
        // heuristic is only trustworthy on a real URL, so everything else has
        // its query dropped wholesale rather than scanned.
        assertEquals("/v1/orders", CrumbtrailRedaction.redactUrl("/v1/orders?access_token=abc"))
        assertEquals("[REDACTED]", CrumbtrailRedaction.redactUrl(""))
        assertFalse(CrumbtrailRedaction.redactUrl("not a url?token=abc123").contains("abc123"))
    }
}

class CrumbtrailTest {
    private class CapturingTransport(private val failWith: Int? = null) : CrumbtrailTransport {
        val batches = mutableListOf<List<CrumbtrailEvent>>()
        var startedSession: String? = null
        var endedSession: String? = null

        override fun startSession(id: String, metadata: JsonValue) { startedSession = id }
        override fun endSession(id: String) { endedSession = id }
        override fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>) {
            batches.add(events)
            failWith?.let { throw CrumbtrailDeliveryException.Refused(it, events.size) }
        }
    }

    private fun config(batchSize: Int = 1000) = CrumbtrailConfig(
        endpoint = "https://api.crumbtrail.ai",
        service = "app",
        flushBatchSize = batchSize,
        // No timer: a background flush would race every assertion below. The
        // tests below also pass `CrumbtrailInlineDelivery`, which has no timer
        // of its own and makes each delivery observable the moment it is asked
        // for. Production never uses it — see CrumbtrailDelivery.
        flushIntervalSeconds = 0,
    )

    @Test
    fun `announces the session and emits a startup environment snapshot`() {
        val transport = CapturingTransport()
        val logger = Crumbtrail(config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery)

        assertEquals(logger.sessionId, transport.startedSession)
        logger.flush()
        assertEquals("env", transport.batches.single().single().kind)
    }

    @Test
    fun `a refusal becomes a declared gap instead of a silent loss`() {
        val transport = CapturingTransport(failWith = 413)
        val logger = Crumbtrail(config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery)

        logger.flush()

        // A session missing events must not read like a session where nothing
        // happened, so the hole is a fact in the timeline rather than an absence.
        assertEquals(1, logger.gaps.size)
        assertEquals("refused-413", logger.gaps.single().reason)
    }

    @Test
    fun `an unreachable endpoint requeues rather than dropping`() {
        val transport = object : CrumbtrailTransport {
            var attempts = 0
            override fun startSession(id: String, metadata: JsonValue) = Unit
            override fun endSession(id: String) = Unit
            override fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>) {
                attempts++
                if (attempts == 1) throw CrumbtrailDeliveryException.Unreachable(events.size)
            }
        }
        val logger = Crumbtrail(config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery)

        logger.flush()
        assertTrue(logger.gaps.isEmpty(), "a network failure is retried, not declared lost")
        logger.flush()
        assertEquals(2, transport.attempts)
    }

    @Test
    fun `flushes automatically once the batch size is reached`() {
        val transport = CapturingTransport()
        val logger = Crumbtrail(
            config(batchSize = 2), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        // The startup env event is already buffered, so one more reaches 2.
        logger.addEvent(CrumbtrailEventKind.ERROR, JsonValue.of("msg" to JsonValue.Str("x")))
        assertEquals(1, transport.batches.size)
    }

    @Test
    fun `recordRequest redacts the url before it is buffered`() {
        val transport = CapturingTransport()
        val logger = Crumbtrail(config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery)

        logger.recordRequest(
            url = "https://api.example.com/v1?access_token=abc123",
            method = "get",
            status = 402,
            durationMs = 318,
        )
        logger.flush()

        val json = transport.batches.single().first { it.kind == "net" }.toJson().toJson()
        assertFalse(json.contains("abc123"))
        assertTrue(json.contains("\"method\":\"GET\""))
        assertTrue(json.contains("\"ok\":false"))
    }

    @Test
    fun `stop flushes and closes the session`() {
        val transport = CapturingTransport()
        val logger = Crumbtrail(config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery)

        logger.stop()
        assertEquals(logger.sessionId, transport.endedSession)
        // Events added after stop are dropped rather than queued forever.
        logger.addEvent(CrumbtrailEventKind.ERROR, JsonValue.of())
        assertEquals(1, transport.batches.size)
    }

    @Test
    fun `activity is touched so a resumed session does not expire mid use`() {
        val store = MemorySessionStore()
        var clock = 1_000L
        val logger = Crumbtrail(
            config(), CapturingTransport(), store, delivery = CrumbtrailInlineDelivery, clock = { clock }
        )
        clock = 50_000
        logger.addEvent(CrumbtrailEventKind.ERROR, JsonValue.of())
        assertEquals(50_000, store.read()?.lastActivity)
    }
}
