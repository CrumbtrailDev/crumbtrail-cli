package ai.crumbtrail.sdk

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.io.IOException
import kotlin.test.*

private class ImmediateDelivery : CrumbtrailDelivery {
    override fun submit(task: () -> Unit): CrumbtrailDeliveryHandle {
        task()
        return object : CrumbtrailDeliveryHandle { override fun await(timeoutMs: Long) = true }
    }
    override fun repeatEvery(seconds: Long, task: () -> Unit) {}
    override fun shutdown() {}
}
private class NetworkTransport : CrumbtrailTransport {
    val events = mutableListOf<CrumbtrailEvent>()
    override fun startSession(id: String, metadata: JsonValue) {}
    override fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>) { this.events.addAll(events) }
    override fun endSession(id: String) {}
}
class OkHttpInterceptorTest {
    private fun logger(transport: NetworkTransport, enabled: Boolean = true) = Crumbtrail(
        CrumbtrailConfig("https://ingest.example.com", collectors = CrumbtrailCollectors(network = enabled)),
        transport, delivery = ImmediateDelivery(),
    )

    @Test fun `real request retains bodies headers and redacts recorded URL`() {
        val transport = NetworkTransport()
        val logger = logger(transport)
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(202).setHeader("x-original", "yes").setBody("original response"))
            val client = OkHttpClient.Builder().addInterceptor(CrumbtrailOkHttpInterceptor(logger)).build()
            client.newCall(Request.Builder().url(server.url("/api?to%6ben=secret")).post("original request".toRequestBody()).build()).execute().use { response ->
                assertEquals(202, response.code)
                assertEquals("yes", response.header("x-original"))
                assertEquals("original response", response.body!!.string())
            }
            assertEquals("original request", server.takeRequest().body.readUtf8())
            logger.flush()
            val event = transport.events.single { it.kind == "net" }.data.toJson()
            assertTrue(event.contains("202"))
            assertFalse(event.contains("secret"))
        }
        logger.stop()
    }

    @Test fun `original failure is rethrown without sensitive message`() {
        val transport = NetworkTransport()
        val logger = logger(transport)
        val failure = IOException("token=secret")
        val client = OkHttpClient.Builder().addInterceptor(CrumbtrailOkHttpInterceptor(logger)).addInterceptor { throw failure }.build()
        assertSame(failure, assertFailsWith<IOException> {
            client.newCall(Request.Builder().url("https://example.com").build()).execute()
        })
        logger.flush()
        val event = transport.events.single { it.kind == "net" }.data.toJson()
        assertTrue(event.contains("IOException"))
        assertFalse(event.contains("secret"))
        logger.stop()
    }

    @Test fun `disabled collector and stopped SDK do not capture`() {
        for (enabled in listOf(false, true)) {
            val transport = NetworkTransport()
            val logger = logger(transport, enabled)
            if (enabled) logger.stop()
            val client = OkHttpClient.Builder().addInterceptor(CrumbtrailOkHttpInterceptor(logger)).addInterceptor {
                okhttp3.Response.Builder().request(it.request()).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("OK").body("ok".toResponseBody()).build()
            }.build()
            client.newCall(Request.Builder().url("https://example.com").build()).execute().close()
            logger.flush()
            assertFalse(transport.events.any { it.kind == "net" })
            logger.stop()
        }
    }
}
