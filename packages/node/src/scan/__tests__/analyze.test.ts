import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../analyze';

const rules = (src: string, file = 'C.tsx') => analyzeSource(file, src).map((f) => f.rule);

describe('analyzeSource: missing-component-id', () => {
  it('flags an interactive element without a stable id', () => {
    expect(rules('export const X = () => <button>Go</button>;')).toContain('missing-component-id');
  });
  it('passes when a stable id is present', () => {
    expect(rules('export const X = () => <button data-bug-id="go">Go</button>;')).not.toContain('missing-component-id');
  });
  it('flags a div that carries an onClick handler', () => {
    expect(rules('export const X = () => <div onClick={f}>Go</div>;')).toContain('missing-component-id');
  });
  it('ignores a plain non-interactive element', () => {
    expect(rules('export const X = () => <div>hi</div>;')).not.toContain('missing-component-id');
  });
  it('does not flag a capitalized React component that merely shares a DOM tag name', () => {
    // <Button> is a user component, not the DOM <button> — flagging it would be a false positive.
    expect(rules('export const X = () => <Button>Go</Button>;')).not.toContain('missing-component-id');
    expect(rules('export const X = () => <Input />;')).not.toContain('missing-component-id');
  });
  it('still flags a capitalized component that carries a handler', () => {
    expect(rules('export const X = () => <Button onClick={f}>Go</Button>;')).toContain('missing-component-id');
  });
});

describe('analyzeSource: swallowed-error', () => {
  it('flags an empty catch block', () => {
    expect(rules('function f(){ try { g(); } catch (e) {} }', 'a.ts')).toContain('swallowed-error');
  });
  it('passes when the catch logs', () => {
    expect(rules('function f(){ try { g(); } catch (e) { console.error(e); } }', 'a.ts')).not.toContain('swallowed-error');
  });
  it('passes when the catch rethrows', () => {
    expect(rules('function f(){ try { g(); } catch (e) { throw e; } }', 'a.ts')).not.toContain('swallowed-error');
  });
});

describe('analyzeSource: actionable fix hints', () => {
  const fixFor = (src: string, file = 'C.tsx') => analyzeSource(file, src)[0]?.fix;

  it('suggests a data-bug-id kebab-cased from the element text', () => {
    expect(fixFor('export const X = () => <button>Add to cart</button>;')).toBe('add data-bug-id="add-to-cart"');
  });

  it('falls back to the tag name when there is no usable text', () => {
    expect(fixFor('export const X = () => <input onChange={f} />;')).toBe('add data-bug-id="input"');
  });

  it('suggests logging or rethrowing for a swallowed error', () => {
    expect(fixFor('function f(){ try { g(); } catch (e) {} }', 'a.ts')).toContain('rethrow');
  });

  it('always attaches a non-empty fix to every finding', () => {
    const findings = analyzeSource('a.tsx', 'export const X = () => <button>Go</button>;');
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.fix.length).toBeGreaterThan(0);
  });
});

describe('analyzeSource: positions', () => {
  it('reports 1-based line and column', () => {
    const [finding] = analyzeSource('a.ts', 'function f(){\n  try { g(); } catch (e) {}\n}');
    expect(finding.line).toBe(2);
    expect(finding.column).toBeGreaterThan(0);
  });
});
