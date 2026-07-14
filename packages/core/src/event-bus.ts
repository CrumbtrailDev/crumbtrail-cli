import type { BugEvent } from "./types";

export class EventBus {
  private listeners: Array<(events: BugEvent[]) => void> = [];
  private taps: Array<(event: BugEvent) => void> = [];
  private buffer: BugEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private flushBufferSize = 100;

  emit(event: BugEvent): void {
    for (const tap of this.taps) {
      try {
        tap(event);
      } catch {
        // A misbehaving tap must never break event capture.
      }
    }
    this.buffer.push(event);
    if (!this.paused && this.buffer.length >= this.flushBufferSize) {
      this.flush();
    }
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

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    for (const listener of this.listeners) {
      listener(batch);
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
