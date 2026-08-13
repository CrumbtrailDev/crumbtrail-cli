import Foundation

/// A bounded, thread-safe buffer of pending events.
///
/// Bounded on purpose. An app that logs in a tight loop, or spends ten minutes
/// offline in a lift, will out-produce the transport. An unbounded queue answers
/// that by growing until the OS kills the app for memory — turning a telemetry
/// SDK into the crash it was installed to explain. Dropping the oldest events
/// instead keeps the most recent window, which is the window a bug is in.
///
/// Drops are counted, never silent. A session that quietly lost half its events
/// reads as a session where nothing happened, and that is the failure mode this
/// whole SDK exists to prevent.
public final class CrumbtrailEventQueue: @unchecked Sendable {
    private let capacity: Int
    private var events: [CrumbtrailEvent] = []
    private var droppedCount = 0
    private let lock = NSLock()

    public init(capacity: Int = 2000) {
        self.capacity = max(1, capacity)
    }

    /// Number of events discarded because the buffer was full.
    public var dropped: Int {
        lock.lock()
        defer { lock.unlock() }
        return droppedCount
    }

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return events.count
    }

    public func append(_ event: CrumbtrailEvent) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
        if events.count > capacity {
            let overflow = events.count - capacity
            events.removeFirst(overflow)
            droppedCount += overflow
        }
    }

    /// Take everything currently buffered, leaving the queue empty.
    public func drain() -> [CrumbtrailEvent] {
        lock.lock()
        defer { lock.unlock() }
        let taken = events
        events = []
        return taken
    }

    /// Put a batch back at the front after a failed send, preserving order.
    ///
    /// Re-appending at the back would reorder a retried batch behind events that
    /// happened after it, and an out-of-order timeline is worse than a short
    /// one: it invents causality that never occurred.
    public func requeue(_ batch: [CrumbtrailEvent]) {
        guard !batch.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        events.insert(contentsOf: batch, at: 0)
        if events.count > capacity {
            let overflow = events.count - capacity
            // Drop from the FRONT here too: the oldest events are still the
            // least useful, even when they are the ones being retried.
            events.removeFirst(overflow)
            droppedCount += overflow
        }
    }
}
