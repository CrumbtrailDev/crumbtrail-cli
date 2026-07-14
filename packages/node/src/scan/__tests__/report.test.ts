import { describe, it, expect } from 'vitest';
import { formatReport } from '../report';

describe('formatReport', () => {
  it('reports a clean result', () => {
    const out = formatReport({ root: '/x', filesScanned: 3, findings: [], countsByRule: {} });
    expect(out).toContain('No coverage gaps');
  });

  it('lists findings as file:line:col [rule] message, a fix hint, and a summary', () => {
    const out = formatReport({
      root: '/x', filesScanned: 1,
      findings: [{ file: 'a.tsx', line: 2, column: 5, rule: 'missing-component-id', message: 'add id', fix: 'add data-bug-id="go"' }],
      countsByRule: { 'missing-component-id': 1 },
    });
    expect(out).toContain('a.tsx:2:5');
    expect(out).toContain('[missing-component-id]');
    expect(out).toContain('↳ fix: add data-bug-id="go"');
    expect(out).toContain('1  missing-component-id');
  });
});
