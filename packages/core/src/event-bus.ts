import type { BugEvent } from "./types";

/** Matches the ring buffer's default ceiling; `Crumbtrail.init()` sets the real one. */
const DEFAULT_MAX_BUFFERED_EVENTS = 50_000;

export class EventBus {
  private listeners: Array<(events: BugEvent[]) => void> = [];
  private taps: Array<(event: BugEvent) => void> = [];
  private buffer: BugEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private flushBufferSize = 100;
  private admissionPredicate: (event: BugEvent) => boolean = () => true;
  /**
   * Ceiling on events waiting for a flush. It only ever bites while the host
   * holds `pause()` — nothing flushes then, not the size trigger and not the
   * interval — and this is a buffer living in a page Crumbtrail did not write.
   */
  private maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS;
  private droppedFromBuffer = 0;

  emit(event: BugEvent, options?: { bypassAdmission?: boolean }): boolean {
    if (!options?.bypassAdmission) {
      try {
        if (!this.admissionPredicate(event)) return false;
      } catch {
        return false;
      }
    }
    for (const tap of this.taps) {
      try {
        tap(event);
      } catch {
        // A misbehaving tap must never break event capture.
      }
    }
    this.buffer.push(event);
    if (this.buffer.length > this.maxBufferedEvents) {
      // Oldest first: after a long pause the events worth keeping are the ones
      // nearest whatever the reader is looking for.
      const overflow = this.buffer.length - this.maxBufferedEvents;
      this.buffer.splice(0, overflow);
      this.droppedFromBuffer += overflow;
    }
    if (!this.paused && this.buffer.length >= this.flushBufferSize) {
      this.flush();
    }
    return true;
  }

  /**
   * Observe every event synchronously at emit time, before batching. Unlike `subscribe`,
   * taps see events immediately (triggers can't wait out a flush interval) and never
   * receive batches.
   */
  tap(fn: (event: BugEvent) => void): () => void {
    this.taps.push(fn);
    return () => {
      const idx = this.taps.indexOf(fn);
      if (idx !== -1) this.taps.splice(idx, 1);
    };
  }

  subscribe(fn: (events: BugEvent[]) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Controls admission before taps, batches, subscribers, and the ring buffer see an event.
   * Privacy and capture policy use this boundary so denied events never rest locally.
   */
  setAdmissionPredicate(predicate: (event: BugEvent) => boolean): void {
    this.admissionPredicate = predicate;
  }

  setMaxBufferedEvents(limit: number): void {
    if (Number.isFinite(limit) && limit > 0) this.maxBufferedEvents = limit;
  }

  /**
   * How many events the cap dropped since this was last asked, and resets the
   * count. The caller turns it into the `capture_gap` that says so: silence
   * about a dropped batch is the one thing the SDK must never produce.
   */
  takeDroppedEventCount(): number {
    const dropped = this.droppedFromBuffer;
    this.droppedFromBuffer = 0;
    return dropped;
  }

  /** Drop events that have not yet been flushed to subscribers. */
  clear(): void {
    this.buffer = [];
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch {
        // `flush()` runs from `emit()`, which runs from inside a patched fetch,
        // a console handler or a click handler — the host application's own
        // stack. A caller-supplied `transportInstance` that throws synchronously
        // must not surface there, and must not cost the subscribers after it
        // (the ring buffer is registered second) the batch.
      }
    }
  }

  start(flushIntervalMs: number, flushBufferSize: number): void {
    this.flushBufferSize = flushBufferSize;
    this.flushTimer = setInterval(() => {
      if (!this.paused) this.flush();
    }, flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.flush();
  }
}
