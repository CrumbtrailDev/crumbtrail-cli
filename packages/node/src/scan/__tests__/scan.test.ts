import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../scan';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bl-scan-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('scanDirectory', () => {
  it('aggregates findings across files and counts by rule', async () => {
    writeFileSync(join(root, 'a.tsx'), 'export const A = () => <button>x</button>;');
    writeFileSync(join(root, 'b.ts'), 'function f(){ try { g(); } catch (e) {} }');
    const report = await scanDirectory(root);
    expect(report.filesScanned).toBe(2);
    expect(report.countsByRule['missing-component-id']).toBe(1);
    expect(report.countsByRule['swallowed-error']).toBe(1);
  });

  it('skips node_modules, declaration files, and test files', async () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.tsx'), 'export const X = () => <button>x</button>;');
    writeFileSync(join(root, 'c.d.ts'), 'export declare const y: number;');
    writeFileSync(join(root, 'd.test.tsx'), 'export const D = () => <button>x</button>;');
    const report = await scanDirectory(root);
    expect(report.filesScanned).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
