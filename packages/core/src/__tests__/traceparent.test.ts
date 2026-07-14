import { describe, it, expect } from 'vitest';
import {
  parseTraceparent,
  formatTraceparent,
  W3C_TRACEPARENT_HEADER,
  generateTraceContext,
  resolveOutboundCorrelation,
} from '../correlation';

describe('traceparent', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const spanId = '00f067aa0ba902b7';

  it('exposes the standard header name', () => {
    expect(W3C_TRACEPARENT_HEADER).toBe('traceparent');
  });

  it('parses a valid traceparent', () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({ traceId, spanId, flags: 1 });
  });

  it('rejects malformed, wrong-version, and all-zero ids', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
    expect(parseTraceparent(`01-${traceId}-${spanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${spanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${traceId}-${'0'.repeat(16)}-01`)).toBeUndefined();
  });

  it('rejects malformed flags (wrong length or non-hex)', () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-1`)).toBeUndefined();
    expect(parseTraceparent(`00-${traceId}-${spanId}-1g`)).toBeUndefined();
    expect(parseTraceparent(`00-${traceId}-${spanId}-001`)).toBeUndefined();
  });

  it('formats a context back into a header string', () => {
    expect(formatTraceparent({ traceId, spanId, flags: 1 })).toBe(`00-${traceId}-${spanId}-01`);
  });

  it('generates a fresh, sampled, well-formed, unique trace context', () => {
    const a = generateTraceContext();
    const b = generateTraceContext();
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.flags).toBe(1);
    expect(a.traceId).not.toBe('0'.repeat(32));
    expect(a.traceId).not.toBe(b.traceId); // controlled randomness
    // round-trips through the spec parser
    expect(parseTraceparent(formatTraceparent(a))).toEqual(a);
  });
});

describe('resolveOutboundCorrelation', () => {
  it('mints a trace context and uses its trace id as the unified request id', () => {
    const c = resolveOutboundCorrelation({ sessionId: 'sess_1' });
    expect(c.sessionId).toBe('sess_1');
    expect(c.requestId).toBe(c.traceId);
    expect(c.traceparent).toBe(`00-${c.traceId}-${c.spanId}-01`);
    expect(parseTraceparent(c.traceparent)).toMatchObject({ traceId: c.traceId });
  });

  it('adopts an existing valid traceparent and joins on its trace id', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
    const c = resolveOutboundCorrelation({ sessionId: 'sess_1', existingTraceparent: traceparent });
    expect(c.traceId).toBe(traceId);
    expect(c.requestId).toBe(traceId);
    expect(c.traceparent).toBe(traceparent);
  });

  it('honors an explicit caller request id while still emitting a traceparent', () => {
    const c = resolveOutboundCorrelation({ sessionId: 'sess_1', existingRequestId: 'caller-request' });
    expect(c.requestId).toBe('caller-request');
    expect(c.traceparent).toBe(`00-${c.traceId}-${c.spanId}-01`);
  });
});
