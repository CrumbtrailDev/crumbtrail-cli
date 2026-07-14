import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../../event-bus';
import { DEFAULT_CONFIG, type BugEvent } from '../../types';
import { networkCollector } from '../network';

// Minimal fetch mock factory
function makeFetchMock(body: string, contentType = 'application/json') {
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status: 200,
      headers: { 'content-type': contentType },
    }),
  );
}

describe('networkCollector – body deduplication', () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup?.();
    events = [];
  });

  function resEvents() {
    bus.flush();
    return events.filter((e) => e.k === 'net.res');
  }

  it('stores full body on first response', async () => {
    globalThis.fetch = makeFetchMock('{"status":"ok"}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch('https://api.example.com/poll');
    const [res] = resEvents();

    expect(res.d.body).toBe('{"status":"ok"}');
    expect(res.d.dedup).toBeUndefined();
  });

  it('deduplicates identical response body for same URL on second call', async () => {
    globalThis.fetch = makeFetchMock('{"status":"ok"}');
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch('https://api.example.com/poll');
    await globalThis.fetch('https://api.example.com/poll');

    const res = resEvents();
    expect(res).toHaveLength(2);

    // First: full body
    expect(typeof res[0].d.body).toBe('string');
    expect(res[0].d.dedup).toBeUndefined();

    // Second: deduplicated reference
    expect(res[1].d.dedup).toBe(true);
    expect((res[1].d.body as Record<string, unknown>).ref).toBeDefined();
  });

  it('does NOT deduplicate when response bodies differ', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      return Promise.resolve(
        new Response(call === 1 ? '{"count":1}' : '{"count":2}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch('https://api.example.com/counter');
    await globalThis.fetch('https://api.example.com/counter');

    const res = resEvents();
    expect(res).toHaveLength(2);
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[1].d.dedup).toBeUndefined();
    expect(res[0].d.body).toBe('{"count":1}');
    expect(res[1].d.body).toBe('{"count":2}');
  });

  it('does NOT deduplicate same body for different URLs', async () => {
    const body = '{"value":42}';
    globalThis.fetch = makeFetchMock(body);
    cleanup = networkCollector(bus, DEFAULT_CONFIG);

    await globalThis.fetch('https://api.example.com/a');
    await globalThis.fetch('https://api.example.com/b');

    const res = resEvents();
    expect(res).toHaveLength(2);
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[1].d.dedup).toBeUndefined();
  });

  it('clears dedup map on cleanup so subsequent collector instances start fresh', async () => {
    globalThis.fetch = makeFetchMock('{"ping":true}');
    const c1 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch('https://api.example.com/ping');
    c1(); // cleanup — clears dedup map

    events = [];
    const c2 = networkCollector(bus, DEFAULT_CONFIG);
    await globalThis.fetch('https://api.example.com/ping');
    cleanup = c2;

    const res = resEvents();
    // After reset the first call should be treated as new, not a dup
    expect(res[0].d.dedup).toBeUndefined();
    expect(res[0].d.body).toBe('{"ping":true}');
  });
});
