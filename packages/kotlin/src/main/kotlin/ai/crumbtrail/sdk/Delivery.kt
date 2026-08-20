package ai.crumbtrail.sdk

import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Where the SDK's own work runs: every delivery, and the periodic flush.
 *
 * This exists because delivery must never happen on the thread that called into
 * the SDK, and on Android the two moments that matter most are both main-thread
 * by construction: `onActivityStopped` (ActivityLifecycleCallbacks are
 * dispatched on the main thread) and the default uncaught-exception handler
 * (which runs on the crashing thread, usually the main one).
 *
 * The platform answers any network operation on the main thread with
 * `NetworkOnMainThreadException`. That is a `RuntimeException`, so it lands in
 * [Crumbtrail.flush]'s catch-all, the batch is requeued into an in-memory queue,
 * and the process dies with the report still inside it — a silent loss that
 * reads exactly like a session where nothing happened. Routing delivery through
 * this interface makes that impossible to reintroduce from a call site, because
 * no call site chooses the thread.
 */
interface CrumbtrailDelivery {
    /** Run [task] off the caller's thread. */
    fun submit(task: () -> Unit): CrumbtrailDeliveryHandle

    /** Run [task] every [seconds] until [shutdown]. */
    fun repeatEvery(seconds: Long, task: () -> Unit)

    /** Stop accepting work. Anything already running is allowed to finish. */
    fun shutdown()
}

/** A submitted task, for the rare caller that has to know it finished. */
interface CrumbtrailDeliveryHandle {
    /** Block for at most [timeoutMs]. Returns whether the task completed. */
    fun await(timeoutMs: Long): Boolean
}

/**
 * The default: one daemon thread, shared by delivery and the flush timer.
 *
 * One thread rather than a pool, because batches must leave in order — two
 * threads posting concurrently can land a later batch first, and an out-of-order
 * timeline invents causality that never occurred. Daemon, so a pending flush can
 * never hold the JVM (or a test run) open after the app is done with it.
 */
class CrumbtrailBackgroundDelivery : CrumbtrailDelivery {
    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "crumbtrail-delivery").apply { isDaemon = true }
        }

    override fun submit(task: () -> Unit): CrumbtrailDeliveryHandle {
        // A submit after shutdown is normal, not exceptional: the app can call
        // stop() while a lifecycle callback is still in flight. Rejecting it
        // quietly is right; throwing out of addEvent() would not be.
        val future: Future<*> = try {
            executor.submit { runCatching(task) }
        } catch (_: Exception) {
            return CompletedHandle
        }
        return FutureHandle(future)
    }

    override fun repeatEvery(seconds: Long, task: () -> Unit) {
        if (seconds <= 0) return
        executor.scheduleWithFixedDelay(
            { runCatching(task) },
            seconds,
            seconds,
            TimeUnit.SECONDS,
        )
    }

    override fun shutdown() {
        executor.shutdown()
    }

    private class FutureHandle(private val future: Future<*>) : CrumbtrailDeliveryHandle {
        override fun await(timeoutMs: Long): Boolean = try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
            true
        } catch (_: Exception) {
            false
        }
    }

    private object CompletedHandle : CrumbtrailDeliveryHandle {
        override fun await(timeoutMs: Long): Boolean = true
    }
}

/**
 * Runs everything inline, on whatever thread called.
 *
 * For tests, which need delivery to be observable the instant it is asked for,
 * and for a host that has already taken the SDK off its own critical threads.
 * Never correct on Android: inline delivery from `Application.onCreate`, an
 * activity lifecycle callback or an uncaught-exception handler is network on the
 * main thread. There is no timer, so a caller using this owns flushing too.
 */
object CrumbtrailInlineDelivery : CrumbtrailDelivery, CrumbtrailDeliveryHandle {
    override fun submit(task: () -> Unit): CrumbtrailDeliveryHandle {
        runCatching(task)
        return this
    }

    override fun repeatEvery(seconds: Long, task: () -> Unit) = Unit

    override fun shutdown() = Unit

    override fun await(timeoutMs: Long): Boolean = true
}
