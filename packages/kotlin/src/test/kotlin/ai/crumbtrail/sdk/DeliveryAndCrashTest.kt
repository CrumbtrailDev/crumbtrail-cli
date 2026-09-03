package ai.crumbtrail.sdk

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Where delivery runs, and what happens to a crash on the way down.
 *
 * Both were broken in the same way and for the same reason. `DefaultHttpClient`
 * blocks on `HttpURLConnection` on whatever thread calls it, and every delivery
 * used to be called inline — from `Application.onCreate` (session announce),
 * from `onActivityStopped` (the last-chance background flush) and from the
 * default uncaught-exception handler (the crash report). All three of those are
 * the Android main thread, where the platform's default StrictMode policy throws
 * `NetworkOnMainThreadException`. That is a `RuntimeException`, so it was caught
 * by flush()'s catch-all, the batch was requeued into memory, and the process
 * died with the report inside it.
 *
 * The suite runs on a desktop JVM, where blocking network on the main thread is
 * perfectly legal — which is exactly why nothing here caught it. So these tests
 * assert the property that actually matters and IS observable off-device: which
 * thread the transport is called on, and whether a crash survives the process.
 */
private class ThreadRecordingTransport : CrumbtrailTransport {
    val threads = mutableListOf<String>()
    val batches = mutableListOf<List<CrumbtrailEvent>>()
    private val lock = Any()
    val arrived = CountDownLatch(1)

    override fun startSession(id: String, metadata: JsonValue) {
        synchronized(lock) { threads.add(Thread.currentThread().name) }
    }

    override fun sendEvents(sessionId: String, events: List<CrumbtrailEvent>) {
        synchronized(lock) {
            threads.add(Thread.currentThread().name)
            batches.add(events)
        }
        arrived.countDown()
    }

    override fun endSession(id: String) {
        synchronized(lock) { threads.add(Thread.currentThread().name) }
    }

    fun threadsSeen(): List<String> = synchronized(lock) { threads.toList() }
}

private fun config(batchSize: Int = 1000) = CrumbtrailConfig(
    endpoint = "https://api.crumbtrail.ai",
    service = "app",
    flushBatchSize = batchSize,
    flushIntervalSeconds = 0,
)

class DeliveryThreadTest {
    @Test
    fun `no delivery runs on the thread that called into the sdk`() {
        val transport = ThreadRecordingTransport()
        val caller = Thread.currentThread().name

        val logger = Crumbtrail(config(), transport, MemorySessionStore())
        logger.addEvent(CrumbtrailEventKind.ERROR, JsonValue.of("msg" to JsonValue.Str("boom")))
        logger.flush()

        assertTrue(
            transport.arrived.await(5, TimeUnit.SECONDS),
            "the batch never reached the transport",
        )
        logger.stop()

        val seen = transport.threadsSeen()
        assertTrue(seen.isNotEmpty(), "the transport was never called")
        for (thread in seen) {
            // The session announce, the flush and endSession all go the same
            // way. On Android `caller` is the main thread, and any of these
            // landing there is a NetworkOnMainThreadException.
            assertNotEquals(caller, thread, "delivery ran on the caller's thread")
        }
    }

    @Test
    fun `stop waits for the tail of the session to leave`() {
        val transport = ThreadRecordingTransport()
        val logger = Crumbtrail(config(), transport, MemorySessionStore())
        logger.addEvent(CrumbtrailEventKind.ERROR, JsonValue.of("msg" to JsonValue.Str("last")))

        logger.stop()

        // stop() is the one delivery a caller is entitled to see finish, so it
        // is awaited rather than fired and forgotten.
        assertTrue(transport.batches.isNotEmpty(), "stop() did not deliver the tail")
        assertTrue(
            transport.threadsSeen().any { it.startsWith("crumbtrail-") },
            "stop() delivered on the caller's thread",
        )
    }
}

class PendingCrashTest {
    private fun uncaught(throwable: Throwable) {
        Thread.getDefaultUncaughtExceptionHandler()
            ?.uncaughtException(Thread.currentThread(), throwable)
    }

    @Test
    fun `a crash is persisted rather than posted from the dying process`() {
        val transport = ThreadRecordingTransport()
        val crashStore = MemoryPendingCrashStore()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        var chained = false
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> chained = true }

        val logger = Crumbtrail(
            config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        try {
            installCrashHandler(logger, crashStore)
            uncaught(IllegalStateException("cart is null"))

            val pending = crashStore.read()
            assertEquals("cart is null", pending?.message)
            assertTrue(pending?.stack?.contains("IllegalStateException") == true)
            assertTrue(chained, "the host's own crash reporter must still run")
            // Nothing was posted: a network round trip cannot complete in a
            // process that is already unwinding, and attempting it on the
            // crashing thread is what lost the report in the first place.
            assertTrue(transport.batches.isEmpty())
        } finally {
            logger.stop()
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    @Test
    fun `the next launch reports the crash the previous one left behind`() {
        val transport = ThreadRecordingTransport()
        val crashStore = MemoryPendingCrashStore(
            CrumbtrailPendingCrash("cart is null", "at Checkout.submit", "main", 1_700_000_000_000)
        )
        val previous = Thread.getDefaultUncaughtExceptionHandler()

        val logger = Crumbtrail(
            config(), transport, MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        try {
            installCrashHandler(logger, crashStore)
            logger.flush()

            val crash = transport.batches.flatten().single { it.kind == "native-crash" }
            val json = crash.toJson().toJson()
            assertTrue(json.contains("cart is null"))
            assertTrue(json.contains("\"stk\":\"at Checkout.submit\""))
            assertTrue(json.contains("\"source\":\"previous-launch\""))
            // Cleared before delivery, so a crash that keeps failing to send
            // cannot re-report itself on every launch forever.
            assertNull(crashStore.read())
        } finally {
            logger.stop()
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    @Test
    fun `multiple logger instances share crash handler ownership safely`() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val firstStore = MemoryPendingCrashStore()
        val secondStore = MemoryPendingCrashStore()
        val first = Crumbtrail(
            config(), ThreadRecordingTransport(), MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        val second = Crumbtrail(
            config(), ThreadRecordingTransport(), MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        try {
            installCrashHandler(first, firstStore)
            val firstHandler = Thread.getDefaultUncaughtExceptionHandler()
            installCrashHandler(second, secondStore)
            val secondHandler = Thread.getDefaultUncaughtExceptionHandler()

            assertTrue(firstHandler === secondHandler)
            first.stop()
            assertTrue(
                Thread.getDefaultUncaughtExceptionHandler() === secondHandler,
                "stopping one logger must not remove the other logger's handler",
            )
            second.stop()
            assertTrue(Thread.getDefaultUncaughtExceptionHandler() === previous)
        } finally {
            first.stop()
            second.stop()
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }

    @Test
    fun `the newest active logger owns crash storage and older logger resumes ownership`() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val firstStore = MemoryPendingCrashStore()
        val secondStore = MemoryPendingCrashStore()
        val first = Crumbtrail(
            config(), ThreadRecordingTransport(), MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        val second = Crumbtrail(
            config(), ThreadRecordingTransport(), MemorySessionStore(), delivery = CrumbtrailInlineDelivery
        )
        try {
            Thread.setDefaultUncaughtExceptionHandler { _, _ -> }
            installCrashHandler(first, firstStore)
            installCrashHandler(second, secondStore)

            uncaught(IllegalStateException("second"))
            assertNull(firstStore.read())
            assertEquals("second", secondStore.read()?.message)

            second.stop()
            uncaught(IllegalStateException("first"))
            assertEquals("first", firstStore.read()?.message)
        } finally {
            first.stop()
            second.stop()
            Thread.setDefaultUncaughtExceptionHandler(previous)
        }
    }
}
