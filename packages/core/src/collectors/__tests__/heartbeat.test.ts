import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../../event-bus';
import { DEFAULT_CONFIG, type BugEvent } from '../../types';
import { heartbeatCollector } from '../heartbeat';

describe('heartbeatCollector', () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = heartbeatCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('emits an hb event after 30 seconds', () => {
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe('hb');
  });

  it('emits dom count in the payload', () => {
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(typeof events[0].d.dom).toBe('number');
  });

  it('emits multiple hb events over time', () => {
    vi.advanceTimersByTime(90_000);
    bus.flush();

    expect(events.length).toBe(3);
    expect(events.every((e) => e.k === 'hb')).toBe(true);
  });

  it('stops emitting after cleanup', () => {
    cleanup();
    vi.advanceTimersByTime(30_000);
    bus.flush();

    expect(events).toHaveLength(0);
    // reassign so afterEach cleanup doesn't error on double-call
    cleanup = () => {};
  });
});
