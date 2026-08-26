import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../ring-buffer';
import type { BugEvent } from '../types';

function evt(t: number, k = 'test'): BugEvent {
  return { t, k, d: {} };
}

describe('RingBuffer', () => {
  it('stores and retrieves events', () => {
    const buf = new RingBuffer(60_000, 100);
    buf.push(evt(1000));
    buf.push(evt(2000));
    expect(buf.size).toBe(2);
    expect(buf.snapshot()).toHaveLength(2);
  });

  it('evicts events older than maxMs', () => {
    const buf = new RingBuffer(5000, 100);
    buf.push(evt(1000));
    buf.push(evt(3000));
    buf.push(evt(7000)); // 7000 - 5000 = 2000 cutoff, so t=1000 evicted
    expect(buf.size).toBe(2);
    expect(buf.snapshot().map((e) => e.t)).toEqual([3000, 7000]);
  });

  it('evicts when exceeding maxEvents', () => {
    const buf = new RingBuffer(60_000, 3);
    buf.push(evt(1000));
    buf.push(evt(2000));
    buf.push(evt(3000));
    buf.push(evt(4000));
    expect(buf.size).toBe(3);
    expect(buf.snapshot()[0].t).toBe(2000);
  });

  it('pushBatch adds multiple events', () => {
    const buf = new RingBuffer(60_000, 100);
    buf.pushBatch([evt(1000), evt(2000), evt(3000)]);
    expect(buf.size).toBe(3);
  });

  it('snapshot with custom windowMs', () => {
    const buf = new RingBuffer(60_000, 100);
    buf.push(evt(1000));
    buf.push(evt(5000));
    buf.push(evt(9000));
    const snap = buf.snapshot(5000); // cutoff = 9000 - 5000 = 4000
    expect(snap.map((e) => e.t)).toEqual([5000, 9000]);
  });

  it('clear empties the buffer', () => {
    const buf = new RingBuffer(60_000, 100);
    buf.pushBatch([evt(1000), evt(2000)]);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.snapshot()).toEqual([]);
  });

  // A remote capture policy moves these bounds mid-session. The buffer used to read them only
  // at construction, so a lowered retention took effect on the next page load.
  describe('setBounds', () => {
    it('shrinking maxEvents evicts oldest-first on the spot', () => {
      const buf = new RingBuffer(60_000, 100);
      buf.pushBatch([evt(1000), evt(2000), evt(3000), evt(4000)]);
      buf.setBounds({ maxEvents: 2 });
      expect(buf.snapshot().map((e) => e.t)).toEqual([3000, 4000]);
    });

    it('shrinking maxMs evicts against the newest event', () => {
      const buf = new RingBuffer(60_000, 100);
      buf.pushBatch([evt(1000), evt(5000), evt(9000)]);
      buf.setBounds({ maxMs: 5000 }); // cutoff = 9000 - 5000 = 4000
      expect(buf.snapshot().map((e) => e.t)).toEqual([5000, 9000]);
    });

    it('growing raises the ceiling and drops nothing', () => {
      const buf = new RingBuffer(60_000, 2);
      buf.pushBatch([evt(1000), evt(2000), evt(3000)]);
      expect(buf.size).toBe(2);
      buf.setBounds({ maxEvents: 10 });
      expect(buf.snapshot().map((e) => e.t)).toEqual([2000, 3000]);
      buf.push(evt(4000));
      buf.push(evt(5000));
      expect(buf.snapshot().map((e) => e.t)).toEqual([2000, 3000, 4000, 5000]);
    });

    it('a new bound governs later pushes, not only the events already held', () => {
      const buf = new RingBuffer(60_000, 100);
      buf.setBounds({ maxEvents: 2 });
      buf.pushBatch([evt(1000), evt(2000), evt(3000)]);
      expect(buf.snapshot().map((e) => e.t)).toEqual([2000, 3000]);
    });

    // The bounds arrive from an unauthenticated response body; a NaN cutoff would evict
    // everything, so a value that is not a usable number leaves the bound alone.
    it('ignores non-finite and negative values', () => {
      const buf = new RingBuffer(60_000, 3);
      buf.pushBatch([evt(1000), evt(2000), evt(3000)]);
      buf.setBounds({ maxMs: Number.NaN, maxEvents: -1 });
      expect(buf.size).toBe(3);
      buf.setBounds({ maxMs: Number.POSITIVE_INFINITY });
      expect(buf.size).toBe(3);
    });
  });
});
