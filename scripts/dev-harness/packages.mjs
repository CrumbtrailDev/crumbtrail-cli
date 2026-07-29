// Discovers the SDK packages this checkout publishes, so nothing downstream has
// to hardcode a name -> directory map that goes stale the moment a package is
// added or renamed.
//
// Every consumer (playground, main app, a real adopter app) resolves these by
// package NAME, so the name is the join key between "what this repo builds" and
// "what a target repo has installed".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/**
 * @returns {Map<string, {name: string, dir: string, version: string, private: boolean}>}
 *          keyed by package name
 */
export function localPackages() {
  const found = new Map();
  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PACKAGES_DIR, entry.name);
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.name) continue;
    found.set(manifest.name, {
      name: manifest.name,
      dir,
      version: manifest.version ?? '0.0.0',
      private: manifest.private === true,
    });
  }
  return found;
}

/**
 * A package is only linkable if its build output exists — a symlink to a package
 * with no dist/ resolves to a module with no main, which fails at require() time
 * with an error that looks nothing like "you forgot to build".
 *
 * Checks for CONTENT, not just the directory: `tsup --watch` cleans dist/ and
 * leaves the empty directory behind, so an existence check reports "built" for a
 * package whose output was just wiped.
 *
 * This answers "has this EVER been built", NOT "is this build current". A dist
 * full of last week's bytes passes. Anything that needs currency must compare
 * the artifact's contents against source — see builtBundleVersion.
 */
export function isBuilt(pkg) {
  const dist = path.join(pkg.dir, 'dist');
  try {
    return fs.readdirSync(dist).length > 0;
  } catch {
    return false;
  }
}

/**
 * The package version BAKED INTO a built bundle, or null if it cannot be found.
 *
 * crumbtrail-node reports its version two different ways, and only one of them
 * detects a stale build:
 *   - src/version.ts walks up to the nearest package.json AT RUNTIME, so the CLI's
 *     `--version` reads the manifest on disk and matches it no matter how old
 *     dist/ is. Useless as a staleness check.
 *   - src/health.ts does `import packageJson from "../package.json"`, which esbuild
 *     INLINES at build time. GET /health therefore reports the version the bundle
 *     was built from, which is exactly the signal we want.
 *
 * So we read the inlined manifest back out of the bundle. Deliberately tolerant of
 * whitespace and minification; a null return means "the format moved", which
 * callers must surface loudly rather than treat as "fine".
 */
export function builtBundleVersion(bundleFile, packageName) {
  let source;
  try {
    source = fs.readFileSync(bundleFile, 'utf8');
  } catch {
    return null;
  }
  const anchor = new RegExp(`name:\\s*["']${packageName}["']`).exec(source);
  if (!anchor) return null;
  const window = source.slice(anchor.index, anchor.index + 400);
  return /version:\s*["']([^"']+)["']/.exec(window)?.[1] ?? null;
}

/**
 * Wait until a built bundle is BOTH current and finished being written.
 *
 * `fs.existsSync` is not enough, and the failure it allows is the nastiest kind:
 * dist/cli.cjs almost always exists already from a previous build, so an
 * existence check returns instantly and a consumer is pointed at whatever bytes
 * happen to be on disk — including bytes a watcher is midway through replacing.
 * A server started that way comes up, answers /health, and reports the OLD
 * version, so a local SDK edit looks like it simply had no effect.
 *
 * Two conditions, both required:
 *   1. the version inlined in the bundle matches the manifest (not stale)
 *   2. size and mtime are unchanged across consecutive polls (not mid-write)
 *
 * Condition 2 matters even right after a successful build, because watchers
 * start their own initial pass and rewrite the file underneath us.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: 'missing'|'stale'|'unreadable', found?: string}>}
 */
export async function waitForFreshEntry(
  file,
  packageName,
  expectedVersion,
  { timeoutMs = 60000, pollMs = 250 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let lastSeenVersion = null;
  while (Date.now() < deadline) {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      // not written yet
    }
    if (stat) {
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      lastSeenVersion = builtBundleVersion(file, packageName);
      if (lastSeenVersion === expectedVersion && stamp === previous) {
        return { ok: true };
      }
      previous = stamp;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  if (lastSeenVersion === null) return { ok: false, reason: 'unreadable' };
  return { ok: false, reason: 'stale', found: lastSeenVersion };
}
