import type { BugEvent } from './types';

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
    const now = this.events.length > 0 ? this.events[this.events.length - 1].t : Date.now();
    const cutoff = now - (windowMs ?? this.maxMs);
    return this.events.filter((e) => e.t >= cutoff);
  }

  clear(): void {
    this.events = [];
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
