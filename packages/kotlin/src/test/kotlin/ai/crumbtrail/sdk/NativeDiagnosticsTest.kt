package ai.crumbtrail.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ai.crumbtrail.sdk.android.androidProcessExitReason

private class FakeWatchdogScheduler : CrumbtrailWatchdogScheduler {
    private data class Entry(
        val action: () -> Unit,
        var cancelled: Boolean = false,
    )

    private val scheduled = ArrayDeque<Entry>()
    private val main = ArrayDeque<() -> Unit>()
    private val background = ArrayDeque<() -> Unit>()
    var shutdownCalled = false

    val scheduledCount: Int get() = scheduled.count { !it.cancelled }

    override fun schedule(delayMs: Long, task: () -> Unit): CrumbtrailWatchdogTask {
        val entry = Entry(task)
        scheduled.addLast(entry)
        return CrumbtrailWatchdogTask { entry.cancelled = true }
    }

    override fun postToMain(task: () -> Unit) { main.addLast(task) }
    override fun postToBackground(task: () -> Unit) { background.addLast(task) }
    override fun drain() { runBackground() }

    override fun shutdown() { shutdownCalled = true }

    fun runNextScheduled() {
        val entry = scheduled.removeFirstOrNull() ?: error("no scheduled task")
        if (!entry.cancelled) entry.action()
    }

    fun runMain() {
        while (main.isNotEmpty()) main.removeFirst()()
    }

    fun runBackground() {
        while (background.isNotEmpty()) background.removeFirst()()
    }
}

private class MarkerStore(private var timestamp: Long? = null) : CrumbtrailProcessExitMarker {
    override fun read(): Long? = timestamp
    override fun write(timestamp: Long) { this.timestamp = timestamp }
}

class MainThreadWatchdogTest {
    @Test
    fun `quoted authorization and boundary expansion stay redacted and stable`() {
        for (scheme in listOf("Basic", "Bearer")) {
            for (input in listOf("Authorization: \"$scheme abc123==\"", "{\"Authorization\": \"$scheme abc123==\"}")) {
                val sanitized = redactedDiagnosticText(input)
                assertFalse(sanitized!!.contains("abc123"))
                assertEquals(sanitized, redactedDiagnosticText(sanitized))
            }
        }
        val input = "token=x ".repeat(2_000)
        for (limit in (1..64).toList() + MAX_DIAGNOSTIC_STACK_CHARS) {
            val sanitized = redactedDiagnosticText(input, limit)!!
            assertTrue(sanitized.length <= limit)
            assertEquals(sanitized, redactedDiagnosticText(sanitized, limit))
        }
    }

    @Test
    fun `sanitizing durable handoff retains recovery ownership at the stack limit`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = object : CrumbtrailPendingHangStore {
            var stored: CrumbtrailPendingHang? = null
            override fun write(hang: CrumbtrailPendingHang) { stored = hang.copy(stack = redactedDiagnosticText(hang.stack)) }
            override fun read() = stored?.let { it.copy(stack = redactedDiagnosticText(it.stack)) }
            override fun clear() { stored = null }
        }
        var now = 0L
        var accepted = 0
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler, handoff = handoff,
            onHang = { accepted++; true }, now = { now },
            captureStack = { "token=x ".repeat(2_000) },
        )
        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        assertNotNull(handoff.read())
        now = 6_000
        scheduler.runMain()
        scheduler.runBackground()
        assertEquals(1, accepted)
        assertNull(handoff.read())
    }

    @Test
    fun `authorization redaction removes schemes and credentials idempotently`() {
        for (key in listOf("Authorization", "authorization", "PROXY-AUTHORIZATION")) {
            for (scheme in listOf("Bearer", "bEaReR", "Basic", "BASIC")) {
                for (spacing in listOf(" ", "\t", "  ")) {
                    val input = "$key$spacing:$spacing$scheme${spacing}abc123==; request failed"
                    val expected = "$key$spacing:$spacing[REDACTED]; request failed"
                    assertEquals(expected, redactedDiagnosticText(input))
                    assertEquals(expected, redactedDiagnosticText(expected))
                }
            }
        }
        val ordinary = "Request failed with HTTP 401 at Checkout.submit()"
        assertEquals(ordinary, redactedDiagnosticText(ordinary))
    }

    @Test
    fun `native collectors require explicit opt in`() {
        assertFalse(CrumbtrailCollectors().nativeWatchdog)
        assertFalse(CrumbtrailCollectors().nativeDiagnostics)
        assertTrue(CrumbtrailCollectors(nativeWatchdog = true, nativeDiagnostics = true).nativeWatchdog)
        assertTrue(CrumbtrailCollectors(nativeWatchdog = true, nativeDiagnostics = true).nativeDiagnostics)
    }

    @Test
    fun `native watchdog observes lifecycle without emitting lifecycle events`() {
        val collectors = CrumbtrailCollectors(
            appLifecycle = false,
            navigation = false,
            nativeWatchdog = true,
        )

        assertTrue(collectors.needsApplicationLifecycleObserver)
        assertFalse(collectors.appLifecycle)
        assertFalse(collectors.navigation)
    }

    @Test
    fun `platform lifecycle observation follows each independent collector flag`() {
        for (appLifecycle in listOf(false, true)) {
            for (navigation in listOf(false, true)) {
                for (nativeWatchdog in listOf(false, true)) {
                    val collectors = CrumbtrailCollectors(
                        appLifecycle = appLifecycle,
                        navigation = navigation,
                        nativeWatchdog = nativeWatchdog,
                    )

                    assertEquals(
                        appLifecycle || navigation || nativeWatchdog,
                        collectors.needsApplicationLifecycleObserver,
                    )
                    assertEquals(appLifecycle, collectors.appLifecycle)
                    assertEquals(navigation, collectors.navigation)
                    assertEquals(nativeWatchdog, collectors.nativeWatchdog)
                }
            }
        }
    }

    @Test
    fun `uses a five second threshold and persists a missed heartbeat`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        var wallNow = 100_000L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = { true },
            now = { now },
            wallNow = { wallNow },
            captureStack = { "main frame" },
        )

        assertEquals(5_000L, watchdog.threshold)
        watchdog.start()
        scheduler.runMain()
        now = 4_999
        scheduler.runNextScheduled()
        assertNull(handoff.read())
        now = 5_000
        wallNow = 90_000
        scheduler.runNextScheduled()
        assertEquals(5_000L, handoff.read()?.observedDurationMs)
        assertEquals("main frame", handoff.read()?.stack)
        assertEquals(90_000L, handoff.read()?.at)
        assertEquals(85_000L, handoff.read()?.startedAt)
    }

    @Test
    fun `emits a recovered hang once and clears its handoff`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        val observations = mutableListOf<CrumbtrailNativeHang>()
        var now = 0L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = observations::add,
            now = { now },
            captureStack = { "stack" },
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 6_200
        scheduler.runMain()

        assertEquals(0, observations.size)
        assertNotNull(handoff.read())
        scheduler.runBackground()
        assertEquals(1, observations.size)
        assertTrue(observations.single().recovered)
        assertFalse(observations.single().previousLaunch)
        assertEquals(6_200L, observations.single().observedDurationMs)
        assertNull(handoff.read())
        scheduler.runMain()
        assertEquals(1, observations.size)
    }

    @Test
    fun `stop drains recovery cleanup without main thread disk work`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = { true },
            now = { now },
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 5_100
        scheduler.runMain()
        assertNotNull(handoff.read())

        watchdog.stop()

        assertNull(handoff.read())
        assertTrue(scheduler.shutdownCalled)
    }

    @Test
    fun `retains handoff when hang callback does not accept`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = { false },
            now = { now },
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 5_100
        scheduler.runMain()
        scheduler.runBackground()

        assertNotNull(handoff.read())
    }

    @Test
    fun `does not clear a replacement handoff after accepting a recovered hang`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        val replacement = CrumbtrailPendingHang(5_000, 5_000, "replacement", 200)
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = {
                handoff.write(replacement)
                true
            },
            now = { now },
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        now = 5_100
        scheduler.runMain()
        scheduler.runBackground()

        assertEquals(replacement, handoff.read())
    }

    @Test
    fun `retains previous launch handoff when import is rejected`() {
        val store = MemoryPendingHangStore(
            CrumbtrailPendingHang(
                thresholdMs = 5_000,
                observedDurationMs = 8_000,
                stack = "old stack",
                at = 1,
            )
        )

        assertFalse(drainPendingHang(store) { false })
        assertNotNull(store.read())
    }

    @Test
    fun `a replaced shared handoff does not wedge the watchdog`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = { true },
            now = { now },
            wallNow = { 100 },
        )

        watchdog.start()
        scheduler.runMain()
        now = 5_000
        scheduler.runNextScheduled()
        handoff.write(CrumbtrailPendingHang(5_000, 5_000, "other", 200))

        now = 5_100
        scheduler.runMain()
        handoff.clear()
        now = 10_100
        scheduler.runNextScheduled()

        assertNotNull(handoff.read(), "a competing instance must not leave this watchdog stuck")
    }

    @Test
    fun `pause suppresses checks and debugger suppresses start`() {
        val pausedScheduler = FakeWatchdogScheduler()
        val pausedStore = MemoryPendingHangStore()
        var pausedNow = 0L
        val paused = CrumbtrailMainThreadWatchdog(
            scheduler = pausedScheduler,
            handoff = pausedStore,
            onHang = { true },
            now = { pausedNow },
        )
        paused.start()
        pausedScheduler.runMain()
        paused.pause()
        pausedNow = 99_000
        pausedScheduler.runNextScheduled()
        assertNull(pausedStore.read())

        val debugScheduler = FakeWatchdogScheduler()
        var attached = true
        val debug = CrumbtrailMainThreadWatchdog(
            scheduler = debugScheduler,
            handoff = MemoryPendingHangStore(),
            onHang = { true },
            isDebuggerAttached = { attached },
        )
        debug.start()
        assertTrue(debugScheduler.shutdownCalled.not())
        assertEquals(1, debugScheduler.scheduledCount)
        attached = false
        debugScheduler.runNextScheduled()
        assertEquals(1, debugScheduler.scheduledCount)

        val attachedScheduler = FakeWatchdogScheduler()
        var dynamicallyAttached = false
        val attachedWatchdog = CrumbtrailMainThreadWatchdog(
            scheduler = attachedScheduler,
            handoff = MemoryPendingHangStore(),
            onHang = { true },
            isDebuggerAttached = { dynamicallyAttached },
        )
        attachedWatchdog.start()
        attachedScheduler.runMain()
        dynamicallyAttached = true
        attachedScheduler.runNextScheduled()
        assertEquals(1, attachedScheduler.scheduledCount)
        dynamicallyAttached = false
        attachedScheduler.runNextScheduled()
        assertEquals(1, attachedScheduler.scheduledCount)

        val racedScheduler = FakeWatchdogScheduler()
        var racedAttached = true
        var pauseDuringPoll = false
        lateinit var racedWatchdog: CrumbtrailMainThreadWatchdog
        racedWatchdog = CrumbtrailMainThreadWatchdog(
            scheduler = racedScheduler,
            handoff = MemoryPendingHangStore(),
            onHang = { true },
            isDebuggerAttached = {
                if (pauseDuringPoll) {
                    pauseDuringPoll = false
                    racedWatchdog.pause()
                }
                racedAttached
            },
        )
        racedWatchdog.start()
        racedAttached = false
        pauseDuringPoll = true
        racedScheduler.runNextScheduled()
        assertEquals(0, racedScheduler.scheduledCount)
    }

    @Test
    fun `imports a previous launch handoff once as an unrecovered hang`() {
        val store = MemoryPendingHangStore(
            CrumbtrailPendingHang(
                thresholdMs = 5_000,
                observedDurationMs = 12_000,
                stack = "old stack",
                at = 1,
            )
        )
        val observations = mutableListOf<CrumbtrailNativeHang>()
        drainPendingHang(store, observations::add)
        drainPendingHang(store, observations::add)

        assertEquals(1, observations.size)
        assertFalse(observations.single().recovered)
        assertTrue(observations.single().previousLaunch)
        assertNull(store.read())
    }

    @Test
    fun `bounds diagnostic text and process exit descriptions`() {
        assertEquals(8_192, boundedDiagnosticText("x".repeat(20_000))?.length)
        assertEquals("authorization: [REDACTED]", redactedDiagnosticText("authorization: secret"))
        val reader = object : CrumbtrailProcessExitReader {
            override fun read(maxEntries: Int): List<CrumbtrailProcessExit> {
                assertEquals(8, maxEntries)
                return listOf(
                    CrumbtrailProcessExit(
                        reason = "anr",
                        timestamp = 20,
                        description = "x".repeat(5_000),
                    ),
                )
            }
        }
        val marker = MarkerStore()
        val exits = mutableListOf<CrumbtrailProcessExit>()
        CrumbtrailProcessExitCollector(reader, marker, exits::add).collect()

        assertEquals(1, exits.size)
        assertNotNull(exits.single().description)
        assertEquals(1_024, exits.single().description?.length)
        CrumbtrailProcessExitCollector(reader, marker, exits::add).collect()
        assertEquals(1, exits.size)
    }

    @Test
    fun `emits every new process exit and advances only after acceptance`() {
        val marker = MarkerStore(10)
        val entries = listOf(
            CrumbtrailProcessExit("anr", 30),
            CrumbtrailProcessExit("crash", 20),
            CrumbtrailProcessExit("old", 10),
        )
        val emitted = mutableListOf<CrumbtrailProcessExit>()
        CrumbtrailProcessExitCollector(
            reader = object : CrumbtrailProcessExitReader {
                override fun read(maxEntries: Int) = entries
            },
            marker = marker,
            emit = { exit -> emitted.add(exit) },
        ).collect()

        assertEquals(listOf(20L, 30L), emitted.map { it.timestamp })
        assertEquals(30L, marker.read())

        val retryMarker = MarkerStore()
        var accept = false
        val retryEmitted = mutableListOf<CrumbtrailProcessExit>()
        val retryCollector = CrumbtrailProcessExitCollector(
            reader = object : CrumbtrailProcessExitReader {
                override fun read(maxEntries: Int) = listOf(CrumbtrailProcessExit("anr", 40))
            },
            marker = retryMarker,
            emit = {},
            acknowledge = { exit -> retryEmitted.add(exit); accept },
        )
        retryCollector.collect()
        assertNull(retryMarker.read())
        accept = true
        retryCollector.collect()
        assertEquals(40L, retryMarker.read())
        assertEquals(2, retryEmitted.size)
    }

    @Test
    fun `maps modern Android process exit reasons explicitly`() {
        // API 30 ApplicationExitInfo values are tested through the plain JVM seam.
        assertEquals("package-updated", androidProcessExitReason(16))
        assertEquals("package-state-change", androidProcessExitReason(15))
        assertEquals("freezer", androidProcessExitReason(14))
        assertEquals("exit-self", androidProcessExitReason(1))
        assertEquals("signaled", androidProcessExitReason(2))
        assertEquals("unknown", androidProcessExitReason(99))
    }
}
