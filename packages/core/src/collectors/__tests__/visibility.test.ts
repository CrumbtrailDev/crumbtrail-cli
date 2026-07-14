import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../event-bus';
import { DEFAULT_CONFIG, type BugEvent } from '../../types';
import { visibilityCollector } from '../visibility';

describe('visibilityCollector', () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = visibilityCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  it('captures visibility change to hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe('vis');
    expect(events[0].d.state).toBe('hidden');
  });

  it('captures visibility change to visible', () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    bus.flush();

    expect(events[0].d.state).toBe('visible');
  });

  it('stops capturing after cleanup', () => {
    cleanup();
    document.dispatchEvent(new Event('visibilitychange'));
    bus.flush();
    expect(events).toHaveLength(0);
    cleanup = visibilityCollector(bus, DEFAULT_CONFIG);
  });
});
