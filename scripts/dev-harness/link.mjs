#!/usr/bin/env node
// Point a target repo's installed Crumbtrail SDK at THIS checkout, without
// touching its package.json, its lockfile, or running an install.
//
// Why not pnpm overrides / pnpm link:
//   Both rewrite the target's manifest or lockfile, which (a) dirties a repo we
//   do not own the working tree of, and (b) in the playground's case fights the
//   vendored-tarball pins that its release gate depends on being exact. This
//   swaps the leaf symlink inside node_modules instead: invisible to git,
//   reversible from a manifest, and undone completely by a plain `pnpm install`
//   even if the manifest is lost.
//
// What it does NOT do: prove packaging. A symlink bypasses `files`, the exports
// map, and prepack checks, so a package that is broken as a TARBALL still works
// when linked. Iterate linked; gate packed (`pnpm playground:refresh-vendor`).
//
// Usage:
//   node scripts/dev-harness/link.mjs status  --target <repo>
//   node scripts/dev-harness/link.mjs link    --target <repo> [--target <repo>…]
//   node scripts/dev-harness/link.mjs unlink  --target <repo> [--target <repo>…]

import fs from 'node:fs';
import path from 'node:path';
import { localPackages, isBuilt, REPO_ROOT } from './packages.mjs';

const MANIFEST_NAME = '.crumbtrail-harness-links.json';
const MAX_DEPTH = 4;

const USAGE = `Usage:
  link.mjs status --target <repo>
  link.mjs link   --target <repo> [--target <repo>…]
  link.mjs unlink --target <repo> [--target <repo>…]`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const targets = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--target') {
      const value = rest[i + 1];
      if (!value) fail('--target needs a path');
      targets.push(path.resolve(value));
      i += 1;
    } else {
      fail(`unknown argument: ${rest[i]}`);
    }
  }
  return { command, targets };
}

function fail(message) {
  console.error(`✗ ${message}`);
  console.error(USAGE);
  process.exit(2);
}

/**
 * Every `node_modules` directory in the target, excluding pnpm's virtual store
 * and anything nested inside another node_modules — those are transitive deps,
 * and repointing them would silently change what a DEPENDENCY sees, not what the
 * target app sees.
 */
function nodeModulesDirs(root, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'node_modules') {
      found.push(full);
      continue; // do not descend: nested node_modules are transitive
    }
    nodeModulesDirs(full, depth + 1, found);
  }
  return found;
}

function manifestPath(target) {
  return path.join(target, MANIFEST_NAME);
}

function readManifest(target) {
  const file = manifestPath(target);
  if (!fs.existsSync(file)) return { links: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { links: [] };
  }
}

function writeManifest(target, manifest) {
  fs.writeFileSync(manifestPath(target), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Sites in `target` where a package this repo builds is installed. */
function linkSites(target, packages) {
  const sites = [];
  for (const dir of nodeModulesDirs(target)) {
    for (const name of packages.keys()) {
      const site = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(site);
      } catch {
        continue; // not installed here
      }
      sites.push({
        name,
        site,
        isSymlink: stat.isSymbolicLink(),
        current: stat.isSymbolicLink() ? fs.readlinkSync(site) : null,
      });
    }
  }
  return sites;
}

function isLinkedToUs(site, packages) {
  if (!site.isSymlink) return false;
  const resolved = path.resolve(path.dirname(site.site), site.current);
  return resolved === packages.get(site.name)?.dir;
}

function cmdStatus(targets, packages) {
  for (const target of targets) {
    const sites = linkSites(target, packages);
    const linked = sites.filter((s) => isLinkedToUs(s, packages));
    console.log(`\n${target}`);
    if (sites.length === 0) {
      console.log('  (no Crumbtrail SDK packages installed — run pnpm install there?)');
      continue;
    }
    console.log(`  mode: ${linked.length === 0 ? 'PACKED' : linked.length === sites.length ? 'LINKED' : 'MIXED'}`);
    for (const site of sites) {
      const rel = path.relative(target, site.site);
      const mark = isLinkedToUs(site, packages) ? '→ local' : '  packed';
      const detail = isLinkedToUs(site, packages)
        ? path.relative(REPO_ROOT, packages.get(site.name).dir)
        : (site.current ?? '(real directory)');
      console.log(`  ${mark}  ${rel}  ${detail}`);
    }
  }
}

function cmdLink(targets, packages) {
  const unbuilt = [...packages.values()].filter((p) => !p.private && !isBuilt(p));
  if (unbuilt.length > 0) {
    fail(
      `these packages have no dist/ yet: ${unbuilt.map((p) => p.name).join(', ')}\n` +
        '  run `pnpm build` (or start the harness, which builds before linking)',
    );
  }

  for (const target of targets) {
    const manifest = readManifest(target);
    const already = new Map(manifest.links.map((l) => [l.site, l]));
    const sites = linkSites(target, packages);
    if (sites.length === 0) {
      console.log(`- ${target}: no SDK packages installed, skipped`);
      continue;
    }

    let linked = 0;
    for (const site of sites) {
      if (isLinkedToUs(site, packages)) continue;
      if (!site.isSymlink) {
        // A real directory means this was not installed by pnpm; replacing it
        // would destroy content we cannot restore from a symlink target.
        console.log(`  ! ${path.relative(target, site.site)} is a real directory, skipped`);
        continue;
      }
      // Record the ORIGINAL target once. Re-linking must never overwrite a
      // previously saved original with another link of ours.
      if (!already.has(site.site)) {
        already.set(site.site, { site: site.site, original: site.current, name: site.name });
      }
      fs.rmSync(site.site, { force: true });
      fs.symlinkSync(packages.get(site.name).dir, site.site, 'dir');
      linked += 1;
    }

    manifest.links = [...already.values()];
    manifest.linkedFrom = REPO_ROOT;
    writeManifest(target, manifest);
    console.log(`✓ ${target}: ${linked} newly linked, ${sites.length} SDK site(s) total`);
  }
}

function cmdUnlink(targets, packages) {
  for (const target of targets) {
    const manifest = readManifest(target);
    if (manifest.links.length === 0) {
      console.log(`- ${target}: nothing to restore`);
      continue;
    }
    let restored = 0;
    let stale = 0;
    for (const link of manifest.links) {
      try {
        fs.rmSync(link.site, { force: true });
        fs.symlinkSync(link.original, link.site, 'dir');
        restored += 1;
      } catch {
        // The original store path can vanish if the target reinstalled while
        // linked. Not fatal — `pnpm install` there rebuilds it.
        stale += 1;
      }
    }
    fs.rmSync(manifestPath(target), { force: true });
    const suffix = stale > 0 ? ` (${stale} stale — run \`pnpm install\` there)` : '';
    console.log(`✓ ${target}: restored ${restored} link(s)${suffix}`);
    void packages;
  }
}

function main() {
  const { command, targets } = parseArgs(process.argv.slice(2));
  if (!command) fail('missing command');
  if (targets.length === 0) fail('at least one --target is required');
  for (const target of targets) {
    if (!fs.existsSync(target)) fail(`target does not exist: ${target}`);
  }

  const packages = localPackages();
  if (command === 'status') return cmdStatus(targets, packages);
  if (command === 'link') return cmdLink(targets, packages);
  if (command === 'unlink') return cmdUnlink(targets, packages);
  fail(`unknown command: ${command}`);
}

main();
