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
 */
export function isBuilt(pkg) {
  return fs.existsSync(path.join(pkg.dir, 'dist'));
}
