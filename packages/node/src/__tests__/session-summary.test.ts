import { describe, it, expect } from 'vitest';
import { buildSessionSummary } from '../session-summary';

const NO_FLAGS = { hasVideo: false, hasDiagnosis: false };

describe('buildSessionSummary', () => {
  it('maps counts, timing, and flags from a complete index', () => {
    const meta = { id: 'ses_1', start: 1000, rootUrl: 'https://example.com' };
    const index = {
      id: 'ses_1',
      start: 1000,
      end: 5000,
      dur: 4000,
      evts: 42,
      errs: [{ t: 1100, msg: 'TypeError: boom' }],
      failedReqs: [{ t: 1200, m: 'POST', url: '/x', st: 500 }, { t: 1300, m: 'GET', url: '/y', st: 503 }],
      navs: [{ t: 1000, to: '/home' }],
    };

    const summary = buildSessionSummary(meta, index, { hasVideo: true, hasDiagnosis: true });

    expect(summary).toMatchObject({
      id: 'ses_1',
      start: 1000,
      end: 5000,
      dur: 4000,
      evts: 42,
      errors: 1,
      failedReqs: 2,
      hasVideo: true,
      hasDiagnosis: true,
    });
  });

  it('derives high severity when there are errors', () => {
    const index = { errs: [{ t: 1, msg: 'x' }], failedReqs: [] };
    expect(buildSessionSummary({ id: 'a', start: 1 }, index, NO_FLAGS).topSeverity).toBe('high');
  });

  it('derives medium severity when only failed requests exist', () => {
    const index = { errs: [], failedReqs: [{ t: 1 }] };
    expect(buildSessionSummary({ id: 'a', start: 1 }, index, NO_FLAGS).topSeverity).toBe('medium');
  });

  it('leaves severity undefined when there are no failures', () => {
    expect(buildSessionSummary({ id: 'a', start: 1 }, {}, NO_FLAGS).topSeverity).toBeUndefined();
  });

  it('prefers a candidate-derived severity passed via fileFlags', () => {
    const index = { errs: [{ t: 1, msg: 'x' }], failedReqs: [] };
    const summary = buildSessionSummary({ id: 'a', start: 1 }, index, {
      hasVideo: false,
      hasDiagnosis: false,
      topSeverity: 'critical',
    });
    expect(summary.topSeverity).toBe('critical');
  });

  it('builds title from the first error message', () => {
    const index = { errs: [{ t: 1, msg: 'Cannot read property foo' }], navs: [{ t: 1, to: '/n' }] };
    expect(buildSessionSummary({ id: 'a', start: 1, rootUrl: 'https://x' }, index, NO_FLAGS).title).toBe('Cannot read property foo');
  });

  it('carries release and build labels from session metadata', () => {
    const summary = buildSessionSummary({ id: 'a', start: 1, release: 'R181', build: 'abc123' }, {}, NO_FLAGS);
    expect(summary.release).toBe('R181');
    expect(summary.build).toBe('abc123');
  });

  it('falls back to first nav, then meta url, then id for the title', () => {
    expect(buildSessionSummary({ id: 'a', start: 1 }, { navs: [{ t: 1, to: '/dashboard' }] }, NO_FLAGS).title).toBe('/dashboard');
    expect(buildSessionSummary({ id: 'a', start: 1, url: 'https://app/x' }, {}, NO_FLAGS).title).toBe('https://app/x');
    expect(buildSessionSummary({ id: 'ses_only_id', start: 1 }, {}, NO_FLAGS).title).toBe('ses_only_id');
  });

  it('truncates long titles to ~120 chars', () => {
    const long = 'e'.repeat(300);
    const summary = buildSessionSummary({ id: 'a', start: 1 }, { errs: [{ t: 1, msg: long }] }, NO_FLAGS);
    expect(summary.title).toHaveLength(120);
  });

  it('degrades gracefully when the index is missing entirely', () => {
    const summary = buildSessionSummary({ id: 'ses_partial', start: 1000 }, undefined, NO_FLAGS);
    expect(summary).toMatchObject({
      id: 'ses_partial',
      start: 1000,
      errors: 0,
      failedReqs: 0,
      hasVideo: false,
      hasDiagnosis: false,
    });
    expect(summary.end).toBeUndefined();
    expect(summary.evts).toBeUndefined();
    expect(summary.topSeverity).toBeUndefined();
  });

  it('falls back to meta timing when the index lacks it', () => {
    const summary = buildSessionSummary({ id: 'a', start: 2000, end: 9000 }, {}, NO_FLAGS);
    expect(summary.start).toBe(2000);
    expect(summary.end).toBe(9000);
  });

  it('reports video and diagnosis flags from fileFlags', () => {
    const summary = buildSessionSummary({ id: 'a', start: 1 }, {}, { hasVideo: true, hasDiagnosis: false });
    expect(summary.hasVideo).toBe(true);
    expect(summary.hasDiagnosis).toBe(false);
  });
});
