import type { BugEvent } from "./types";

export class RingBuffer {
  private events: BugEvent[] = [];
  private maxMs: number;
  private maxEvents: number;

  constructor(maxMs = 300_000, maxEvents = 50_000) {
    this.maxMs = maxMs;
    this.maxEvents = maxEvents;
  }

  push(event: BugEvent): void {
    this.events.push(event);
    this.evict(event.t);
  }

  pushBatch(events: BugEvent[]): void {
    for (const event of events) {
      this.events.push(event);
    }
    if (events.length > 0) {
      this.evict(events[events.length - 1].t);
    }
  }

  snapshot(windowMs?: number): BugEvent[] {
    const now =
      this.events.length > 0
        ? this.events[this.events.length - 1].t
        : Date.now();
    const cutoff = now - (windowMs ?? this.maxMs);
    return this.events.filter((e) => e.t >= cutoff);
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Move the live bounds without rebuilding the buffer, and report how many events the move
   * evicted so the caller can account for the evidence it cost.
   *
   * A remote capture policy sets `ringBufferMs` / `ringBufferMaxEvents` mid-session, and a
   * buffer that only reads its bounds at construction would honour that on the next page load
   * instead of on the poll that asked for it. Tightening evicts immediately and oldest-first,
   * so a policy asking for less retention gets less retention at once rather than after the
   * next push; loosening only raises the ceiling and drops nothing.
   *
   * A bound that is not a whole number, or is below its own minimum, is ignored rather than
   * coerced. The rules match the ones the remote boundary applies — a whole millisecond count
   * for `maxMs`, at least one event for `maxEvents` — so the buffer and the bus that caps the
   * same events can never end up on different ceilings.
   */
  setBounds(bounds: { maxMs?: number; maxEvents?: number }): number {
    let changed = false;
    if (
      typeof bounds.maxMs === "number" &&
      Number.isInteger(bounds.maxMs) &&
      bounds.maxMs >= 0 &&
      bounds.maxMs !== this.maxMs
    ) {
      this.maxMs = bounds.maxMs;
      changed = true;
    }
    if (
      typeof bounds.maxEvents === "number" &&
      Number.isInteger(bounds.maxEvents) &&
      bounds.maxEvents >= 1 &&
      bounds.maxEvents !== this.maxEvents
    ) {
      this.maxEvents = bounds.maxEvents;
      changed = true;
    }
    if (!changed || this.events.length === 0) return 0;
    const before = this.events.length;
    // Evict against the newest event rather than the wall clock, matching `push`: the buffer's
    // notion of "now" is the last event it saw, so a shrink applies the same cutoff a push
    // arriving at that instant would have applied.
    this.evict(this.events[this.events.length - 1].t);
    return before - this.events.length;
  }

  get size(): number {
    return this.events.length;
  }

  private evict(now: number): void {
    const cutoff = now - this.maxMs;
    // Time-based eviction: drop events older than maxMs
    while (this.events.length > 0 && this.events[0].t < cutoff) {
      this.events.shift();
    }
    // Hard cap eviction: drop oldest if over maxEvents
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }
}
