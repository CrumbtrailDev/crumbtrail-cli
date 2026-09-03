package ai.crumbtrail.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeWatchdogScheduler : CrumbtrailWatchdogScheduler {
    private data class Entry(
        val action: () -> Unit,
        var cancelled: Boolean = false,
    )

    private val scheduled = ArrayDeque<Entry>()
    private val main = ArrayDeque<() -> Unit>()
    var shutdownCalled = false

    val scheduledCount: Int get() = scheduled.count { !it.cancelled }

    override fun schedule(delayMs: Long, task: () -> Unit): CrumbtrailWatchdogTask {
        val entry = Entry(task)
        scheduled.addLast(entry)
        return CrumbtrailWatchdogTask { entry.cancelled = true }
    }

    override fun postToMain(task: () -> Unit) { main.addLast(task) }

    override fun shutdown() { shutdownCalled = true }

    fun runNextScheduled() {
        val entry = scheduled.removeFirstOrNull() ?: error("no scheduled task")
        if (!entry.cancelled) entry.action()
    }

    fun runMain() {
        while (main.isNotEmpty()) main.removeFirst()()
    }
}

private class MarkerStore(private var timestamp: Long? = null) : CrumbtrailProcessExitMarker {
    override fun read(): Long? = timestamp
    override fun write(timestamp: Long) { this.timestamp = timestamp }
}

class MainThreadWatchdogTest {
    @Test
    fun `uses a five second threshold and persists a missed heartbeat`() {
        val scheduler = FakeWatchdogScheduler()
        val handoff = MemoryPendingHangStore()
        var now = 0L
        val watchdog = CrumbtrailMainThreadWatchdog(
            scheduler = scheduler,
            handoff = handoff,
            onHang = {},
            now = { now },
            captureStack = { "main frame" },
        )

        assertEquals(5_000L, watchdog.threshold)
        watchdog.start()
        scheduler.runMain()
        now = 4_999
        scheduler.runNextScheduled()
        assertNull(handoff.read())
        now = 5_000
        scheduler.runNextScheduled()
        assertEquals(5_000L, handoff.read()?.observedDurationMs)
        assertEquals("main frame", handoff.read()?.stack)
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

        assertEquals(1, observations.size)
        assertTrue(observations.single().recovered)
        assertFalse(observations.single().previousLaunch)
        assertEquals(6_200L, observations.single().observedDurationMs)
        assertNull(handoff.read())
        scheduler.runMain()
        assertEquals(1, observations.size)
    }

    @Test
    fun `pause suppresses checks and debugger suppresses start`() {
        val pausedScheduler = FakeWatchdogScheduler()
        val pausedStore = MemoryPendingHangStore()
        var pausedNow = 0L
        val paused = CrumbtrailMainThreadWatchdog(
            scheduler = pausedScheduler,
            handoff = pausedStore,
            onHang = {},
            now = { pausedNow },
        )
        paused.start()
        pausedScheduler.runMain()
        paused.pause()
        pausedNow = 99_000
        pausedScheduler.runNextScheduled()
        assertNull(pausedStore.read())

        val debugScheduler = FakeWatchdogScheduler()
        val debug = CrumbtrailMainThreadWatchdog(
            scheduler = debugScheduler,
            handoff = MemoryPendingHangStore(),
            onHang = {},
            isDebuggerAttached = { true },
        )
        debug.start()
        assertTrue(debugScheduler.shutdownCalled.not())
        assertFalse(debugScheduler.scheduledCount > 0)
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
}
