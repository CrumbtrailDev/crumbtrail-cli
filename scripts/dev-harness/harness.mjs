#!/usr/bin/env node
// One command that brings up a local Crumbtrail loop where an SDK edit is
// visible to a running target app in seconds instead of an install cycle.
//
// It does four things, in order, and refuses to lie about any of them:
//   1. build the SDK packages once (a link to a package with no dist/ fails at
//      require() time with an error that looks nothing like the real cause)
//   2. point each target repo's installed SDK at this checkout (see link.mjs)
//   3. keep dist/ fresh with tsup --watch, one watcher per package
//   4. run the capture server and PROVE it is listening before saying it is up
//
// On exit — including Ctrl-C — every target is unlinked back to what it had.
// A crashed harness that leaves a repo linked to a checkout that later changes
// branches is the kind of failure that costs an afternoon to understand.
//
// Usage:
//   node scripts/dev-harness/harness.mjs [--target <repo>…] [--port 9898]
//                                        [--sessions <dir>] [--no-server]
//
// With no --target, both default targets are used if they exist on disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { localPackages, builtBundleVersion, REPO_ROOT } from './packages.mjs';

const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');
const DEFAULT_TARGETS = [
  path.join(WORKSPACE_ROOT, 'crumbtrail-playground'),
  path.join(WORKSPACE_ROOT, 'crumbtrail'),
];
const LINK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'dev-harness', 'link.mjs');
const LOG_DIR = path.join(REPO_ROOT, '.harness-logs');

// Packages worth watching: the ones a target actually loads at runtime. Watching
// all nine wastes CPU on packages no local target consumes.
const WATCHED = ['crumbtrail-core', 'crumbtrail-node', 'crumbtrail-react'];

const options = parseArgs(process.argv.slice(2));
const children = [];
let shuttingDown = false;

function parseArgs(argv) {
  const parsed = {
    targets: [],
    port: 9898,
    sessions: path.join(os.homedir(), '.crumbtrail', 'sessions'),
    server: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') parsed.targets.push(path.resolve(argv[++i] ?? ''));
    else if (arg === '--port') parsed.port = Number(argv[++i]);
    else if (arg === '--sessions') parsed.sessions = path.resolve(argv[++i] ?? '');
    else if (arg === '--no-server') parsed.server = false;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (parsed.targets.length === 0) {
    parsed.targets = DEFAULT_TARGETS.filter((t) => fs.existsSync(t));
  }
  return parsed;
}

const log = (message) => console.log(`[harness] ${message}`);

function run(command, args, cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}

/** A stale listener on the capture port silently swallows every session. */
function freePort(port) {
  const found = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  const pids = (found.stdout ?? '').split('\n').filter(Boolean);
  if (pids.length === 0) return;
  log(`freeing port ${port} (killing ${pids.join(', ')})`);
  spawnSync('kill', ['-9', ...pids]);
}

/**
 * Wait until `file` is BOTH built from the current source and finished being
 * written, then report why if it never gets there.
 *
 * `fs.existsSync` is not enough, and the failure it allows is the nastiest kind:
 * dist/cli.cjs almost always exists already from a previous build, so an
 * existence check returns instantly and the server is spawned against whatever
 * bytes happen to be on disk — including bytes a watcher is midway through
 * replacing. The server then comes up, answers /health, and reports the OLD
 * version, so a local SDK edit looks like it simply had no effect.
 *
 * Two conditions, both required:
 *   1. the version inlined in the bundle matches the manifest (not stale)
 *   2. size and mtime are unchanged across consecutive polls (not mid-write)
 *
 * Condition 2 matters even right after a successful build, because the watchers
 * start their own initial pass and rewrite this exact file underneath us.
 */
async function waitForFreshEntry(file, packageName, expectedVersion, timeoutMs = 60000) {
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  if (lastSeenVersion === null) return { ok: false, reason: 'unreadable' };
  return { ok: false, reason: 'stale', found: lastSeenVersion };
}

/** Resolves to the parsed /health payload, so callers can check what it claims. */
async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function track(name, child, logFile) {
  children.push({ name, child, logFile });
  child.on('exit', (code) => {
    if (shuttingDown || code === 0 || code === null) return;
    log(`✗ ${name} exited with ${code} — see ${path.relative(REPO_ROOT, logFile)}`);
  });
}

function spawnLogged(name, command, args, cwd = REPO_ROOT) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const stream = fs.openSync(logFile, 'w');
  const child = spawn(command, args, { cwd, stdio: ['ignore', stream, stream] });
  track(name, child, logFile);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  log('shutting down…');
  for (const { child } of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  if (options.targets.length > 0) {
    log('restoring targets to packed mode…');
    spawnSync(
      'node',
      [LINK_SCRIPT, 'unlink', ...options.targets.flatMap((t) => ['--target', t])],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
  }
  process.exit(code);
}

async function main() {
  if (options.targets.length === 0) {
    log('no targets found — pass --target <repo>');
    process.exit(2);
  }

  log(`checkout: ${REPO_ROOT}`);
  for (const target of options.targets) log(`target:   ${target}`);

  const packages = localPackages();
  // ALWAYS build — never "only if dist/ looks empty". A dist/ from a previous
  // build is the normal case, so a has-it-ever-been-built check skips the build
  // precisely when the tree is stale, which is the one case that needs it. The
  // full topological build is ~7s and incremental, far cheaper than debugging an
  // SDK edit that silently never took effect.
  //
  // `pnpm -r build` is topological, which matters: crumbtrail-node inlines
  // crumbtrail-core (noExternal) and its DTS step reads core's .d.ts, so core
  // must be fully built first.
  log('building SDK packages…');
  run('pnpm', ['build']);

  log('linking targets to this checkout…');
  run('node', [LINK_SCRIPT, 'link', ...options.targets.flatMap((t) => ['--target', t])]);

  // --no-clean is load-bearing, not an optimisation. Each package's tsup config
  // sets clean:true, so concurrent watchers wipe dist/ at startup — and because
  // crumbtrail-node's DTS build reads crumbtrail-core's .d.ts, core's wipe makes
  // node's build fail with "Could not find a declaration file for module
  // 'crumbtrail-core'". Watch mode never retries that without a source change,
  // so the watcher stays dead and dist/cli.cjs never appears. Building first and
  // then watching without clean removes THAT race.
  //
  // It does not remove all of them: each watcher still runs an initial pass that
  // rewrites dist/ underneath whatever is about to read it. Anything loading a
  // built file must still wait for it to settle — see waitForFreshEntry.
  for (const name of WATCHED) {
    if (!packages.has(name)) continue;
    spawnLogged(`watch-${name}`, 'pnpm', [
      '--filter',
      name,
      'exec',
      'tsup',
      '--watch',
      '--no-clean',
    ]);
    log(`watching ${name}`);
  }

  if (options.server) {
    freePort(options.port);
    fs.mkdirSync(options.sessions, { recursive: true });

    const serverEntry = path.join(REPO_ROOT, 'packages', 'node', 'dist', 'cli.cjs');
    const entryRel = path.relative(REPO_ROOT, serverEntry);
    const watchLog = path.relative(REPO_ROOT, path.join(LOG_DIR, 'watch-crumbtrail-node.log'));
    const expectedVersion = packages.get('crumbtrail-node')?.version;
    if (!expectedVersion) {
      log('✗ crumbtrail-node is missing from packages/ — cannot verify the server build');
      return shutdown(1);
    }

    log('waiting for the watcher to settle on a current server entry…');
    const entry = await waitForFreshEntry(serverEntry, 'crumbtrail-node', expectedVersion);
    if (!entry.ok) {
      if (entry.reason === 'missing') log(`✗ ${entryRel} never appeared`);
      else if (entry.reason === 'stale') {
        log(`✗ ${entryRel} is stale: built from ${entry.found}, expected ${expectedVersion}`);
        log('  the watcher never produced a current build — refusing to start a stale server');
      } else {
        log(`✗ could not read the built version out of ${entryRel}`);
        log("  the bundle no longer inlines package.json where this expects it;");
        log('  fix builtBundleVersion in scripts/dev-harness/packages.mjs');
      }
      log(`  see ${watchLog}`);
      return shutdown(1);
    }

    spawnLogged('capture-server', 'node', [
      serverEntry,
      'serve',
      '--port',
      String(options.port),
      '--output',
      options.sessions, // absolute: a relative path resolves against the package cwd
    ]);
    const health = await waitForHealth(options.port);
    if (!health) {
      log(`✗ capture server never answered /health on :${options.port}`);
      log(`  see ${path.relative(REPO_ROOT, path.join(LOG_DIR, 'capture-server.log'))}`);
      return shutdown(1);
    }
    // The last word on staleness, and the only one that describes the process
    // actually listening: /health reports the version inlined when the bundle it
    // loaded was built. A file that passed the check above can still lose to a
    // watcher rewrite in the moment between the check and the spawn. Failing here
    // is the whole point — a stale server that announces itself as healthy costs
    // an afternoon; one that refuses to start costs a rebuild.
    if (health.version !== expectedVersion) {
      log(`✗ capture server is running STALE code on :${options.port}`);
      log(`  /health reports ${health.version}, but packages/node is ${expectedVersion}`);
      log('  your SDK changes are NOT in the running server. Re-run the harness.');
      return shutdown(1);
    }
    log(`✓ capture server healthy on :${options.port} (v${health.version}) → ${options.sessions}`);
  }

  console.log('');
  log('ready. Edit packages/*/src — watchers rebuild dist, targets see it on restart.');
  log(`logs: ${path.relative(process.cwd(), LOG_DIR)}/`);
  log('Ctrl-C to stop and restore targets to packed mode.');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  log(`✗ ${error.message}`);
  shutdown(1);
});
