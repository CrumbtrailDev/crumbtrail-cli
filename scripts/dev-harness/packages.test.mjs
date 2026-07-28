// Regression cover for the two staleness gates. Both replaced existence checks
// that let the harness start a capture server on a PREVIOUS build and report it
// as healthy, which is the failure mode these tests exist to keep dead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { builtBundleVersion, waitForFreshEntry } from './packages.mjs';

/** How esbuild emits `import packageJson from "../package.json"` into a bundle. */
const bundle = (version, name = 'crumbtrail-node') =>
  `// package.json\nvar package_default = {\n  name: "${name}",\n  version: "${version}",\n  main: "./dist/index.cjs"\n};\n`;

let dir;
let entry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-harness-test-'));
  entry = path.join(dir, 'cli.cjs');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('builtBundleVersion', () => {
  it('reads the version inlined by the build', () => {
    fs.writeFileSync(entry, bundle('0.17.0'));
    expect(builtBundleVersion(entry, 'crumbtrail-node')).toBe('0.17.0');
  });

  it('survives minified and single-quoted output', () => {
    fs.writeFileSync(entry, 'var a={name:"crumbtrail-node",version:"1.2.3"};');
    expect(builtBundleVersion(entry, 'crumbtrail-node')).toBe('1.2.3');

    fs.writeFileSync(entry, "var a={name:'crumbtrail-node',version:'1.2.3'};");
    expect(builtBundleVersion(entry, 'crumbtrail-node')).toBe('1.2.3');
  });

  it('reads the requested package, not merely the first manifest in the bundle', () => {
    fs.writeFileSync(entry, bundle('9.9.9', 'crumbtrail-core') + bundle('0.17.0'));
    expect(builtBundleVersion(entry, 'crumbtrail-node')).toBe('0.17.0');
    expect(builtBundleVersion(entry, 'crumbtrail-core')).toBe('9.9.9');
  });

  // Null is the "I cannot tell" signal callers must surface loudly. Returning a
  // wrong-but-plausible version here would resurrect the silent-staleness bug.
  it('returns null when the bundle no longer inlines the manifest', () => {
    fs.writeFileSync(entry, 'var a={pkgName:"crumbtrail-node"};');
    expect(builtBundleVersion(entry, 'crumbtrail-node')).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(builtBundleVersion(path.join(dir, 'nope.cjs'), 'crumbtrail-node')).toBeNull();
  });
});

describe('waitForFreshEntry', () => {
  const opts = { timeoutMs: 2000, pollMs: 5 };

  it('accepts a settled bundle built from the expected version', async () => {
    fs.writeFileSync(entry, bundle('0.17.0'));
    await expect(waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', opts)).resolves.toEqual({
      ok: true,
    });
  });

  // The original bug: dist/cli.cjs exists, so existsSync says go, and the server
  // boots on last build's bytes.
  it('reports a bundle built from an older version as stale, not present', async () => {
    fs.writeFileSync(entry, bundle('0.16.1'));
    await expect(waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', opts)).resolves.toEqual({
      ok: false,
      reason: 'stale',
      found: '0.16.1',
    });
  });

  it('distinguishes a file that never appears from one that is stale', async () => {
    await expect(waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', opts)).resolves.toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('distinguishes an unreadable bundle format from a stale build', async () => {
    fs.writeFileSync(entry, 'var a={pkgName:"crumbtrail-node"};');
    await expect(waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', opts)).resolves.toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('waits out a watcher that is still rewriting the file', async () => {
    // Correct version from the first byte, so ONLY the quiescence condition can
    // hold this back — exactly the window where the watcher's initial pass
    // rewrites dist/ under a check that already passed on content.
    fs.writeFileSync(entry, bundle('0.17.0'));
    let writes = 0;
    // Rewrite FASTER than the poll interval below, so every poll sees a file
    // that moved since the last one. Quiescence is necessarily relative to the
    // poll rate; a watcher slower than the polls is indistinguishable from a
    // finished one, which is why the version check carries the real weight.
    const rewriting = setInterval(() => {
      writes += 1;
      // Vary the length so size moves even if mtime resolution is coarse.
      fs.writeFileSync(entry, bundle('0.17.0') + '/*'.padEnd(writes * 32, 'x') + '*/');
    }, 5);

    let settledAt = 0;
    setTimeout(() => {
      clearInterval(rewriting);
      settledAt = Date.now();
    }, 150);

    const result = await waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', {
      timeoutMs: 5000,
      pollMs: 25,
    });
    clearInterval(rewriting);

    expect(result).toEqual({ ok: true });
    expect(writes).toBeGreaterThan(1);
    // Resolving before the rewrites stopped would mean it returned mid-write.
    expect(settledAt).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThanOrEqual(settledAt);
  });

  it('does not accept a stale bundle just because it has stopped changing', async () => {
    // A stale dist is perfectly quiescent. Quiescence alone must never pass.
    fs.writeFileSync(entry, bundle('0.16.1'));
    const result = await waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale');
  });

  it('accepts a bundle that becomes current partway through the wait', async () => {
    fs.writeFileSync(entry, bundle('0.16.1'));
    setTimeout(() => fs.writeFileSync(entry, bundle('0.17.0')), 60);
    await expect(
      waitForFreshEntry(entry, 'crumbtrail-node', '0.17.0', { timeoutMs: 5000, pollMs: 5 }),
    ).resolves.toEqual({ ok: true });
  });
});
