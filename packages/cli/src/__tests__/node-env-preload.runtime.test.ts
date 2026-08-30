// The generic backend recipe, RUN in a real Node process.
//
// Sibling of express-env-preload.runtime.test.ts, for the shape that actually
// shipped broken: an entry that loads its OWN env file part-way down, with the
// injected block prepended above it. On a hosted platform the key is a real
// environment variable, so this reads correctly and nobody notices; on a laptop
// the key is in .env, the injected init reads it before the app's own loader
// runs, and capture is silently off in the one place someone is reproducing a
// bug.
//
// String assertions cannot settle an ordering bug, so this wires a real app with
// the REAL buildPlan + executePlan, runs it with plain `node` and no
// --env-file, and reads back the token autoCapture was actually constructed
// with — in the entry AND in the worker beside it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlan } from "../inject/recipes";
import { executePlan } from "../inject/executor";
import { cleanup, makeTmpRepo } from "./helpers";

const ENDPOINT = "https://ingest.example.com";

/**
 * Records what autoCapture was handed, so the test reads what really ran.
 *
 * `exports.autoCapture = ...` rather than `module.exports = { ... }`: the
 * injected block destructures a NAMED export off a dynamic import, and Node's
 * CJS named-export detection only finds the assignment form. The object form
 * resolves with `default` alone, the destructure yields undefined, and the
 * block's own `.catch` swallows the resulting TypeError — a stub that silently
 * proves nothing.
 */
const STUB_SDK = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "function autoCapture(options) {",
  "  fs.appendFileSync(",
  '    path.join(__dirname, "..", "..", "seen.jsonl"),',
  "    JSON.stringify({",
  "      service: options && options.service,",
  "      authToken: options && options.authToken,",
  '    }) + "\\n",',
  "  );",
  "  return { stop: () => {} };",
  "}",
  "exports.autoCapture = autoCapture;",
  "",
].join("\n");

function makeApp(): string {
  return makeTmpRepo({
    "package.json": JSON.stringify({
      name: "app",
      scripts: {
        start: "node src/index.js",
        worker: "node src/worker.js",
      },
    }),
    // The key exists ONLY in .env — exactly what the wizard leaves behind.
    ".env": "CRUMBTRAIL_KEY=ctkey_from_env_file\n",
    // The app loads its own env file, part-way down, the way a real service does.
    "src/index.js": [
      'const path = require("node:path");',
      "",
      "function loadEnvFile() {",
      '  process.loadEnvFile(path.join(__dirname, "..", ".env"));',
      "}",
      "",
      "loadEnvFile();",
      'console.log("started");',
      // A real server holds the event loop open; without that this process
      // exits before the injected dynamic import ever resolves.
      "setTimeout(() => {}, 200);",
      "",
    ].join("\n"),
    "src/worker.js": [
      'console.log("worker started");',
      "setTimeout(() => {}, 200);",
      "",
    ].join("\n"),
    "railway.worker.json": JSON.stringify({
      deploy: { startCommand: "npm run worker" },
    }),
    "node_modules/crumbtrail-node/package.json": JSON.stringify({
      name: "crumbtrail-node",
      version: "0.37.0",
      main: "index.js",
    }),
    "node_modules/crumbtrail-node/index.js": STUB_SDK,
  });
}

function seen(dir: string): Array<{ service?: string; authToken?: string }> {
  return readFileSync(path.join(dir, "seen.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) => JSON.parse(line) as { service?: string; authToken?: string },
    );
}

const CLEAN_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanup(dir);
  dir = undefined;
});

describe("wired Node app, running", () => {
  it("captures with the key from .env even though the app loads .env itself further down", () => {
    dir = makeApp();
    const entry = path.join(dir, "src", "index.js");
    const plan = buildPlan({
      cwd: dir,
      recipe: "node",
      endpoint: ENDPOINT,
      entryFile: entry,
      serviceName: "marginary",
      options: { force: true },
    });
    executePlan(plan);

    execFileSync(process.execPath, [entry], {
      cwd: dir,
      // No CRUMBTRAIL_KEY here: the app must find it in .env itself.
      env: CLEAN_ENV,
      stdio: "pipe",
    });

    expect(seen(dir)).toEqual([
      { service: "marginary", authToken: "ctkey_from_env_file" },
    ]);
  });

  it("captures from the worker too, under its own service name", () => {
    dir = makeApp();
    const entry = path.join(dir, "src", "index.js");
    const plan = buildPlan({
      cwd: dir,
      recipe: "node",
      endpoint: ENDPOINT,
      entryFile: entry,
      serviceName: "marginary",
      options: { force: true },
    });
    executePlan(plan);

    execFileSync(process.execPath, [path.join(dir, "src", "worker.js")], {
      cwd: dir,
      env: CLEAN_ENV,
      stdio: "pipe",
    });

    expect(seen(dir)).toEqual([
      { service: "marginary-worker", authToken: "ctkey_from_env_file" },
    ]);
  });

  it("finds the package's .env when the process is started from the monorepo root", () => {
    // The normal way to start one service of a monorepo, and the only way a
    // root Dockerfile can: cwd is the root, the env file is in the package.
    dir = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["services/*"],
      }),
      "services/api/package.json": JSON.stringify({
        name: "api",
        scripts: { start: "node src/index.js" },
      }),
      "services/api/.env": "CRUMBTRAIL_KEY=ctkey_in_the_package\n",
      "services/api/src/index.js": [
        'console.log("started");',
        "setTimeout(() => {}, 200);",
        "",
      ].join("\n"),
      "node_modules/crumbtrail-node/package.json": JSON.stringify({
        name: "crumbtrail-node",
        version: "0.37.0",
        main: "index.js",
      }),
      "node_modules/crumbtrail-node/index.js": STUB_SDK,
    });
    const pkgDir = path.join(dir, "services", "api");
    const entry = path.join(pkgDir, "src", "index.js");
    executePlan(
      buildPlan({
        cwd: pkgDir,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: entry,
        serviceName: "api",
        options: { force: true },
      }),
    );

    for (const cwd of [dir, pkgDir]) {
      execFileSync(process.execPath, [entry], {
        cwd,
        env: CLEAN_ENV,
        stdio: "pipe",
      });
    }

    expect(seen(dir)).toEqual([
      { service: "api", authToken: "ctkey_in_the_package" },
      { service: "api", authToken: "ctkey_in_the_package" },
    ]);
  });

  it("never overwrites a key that is already in the environment", () => {
    dir = makeApp();
    const entry = path.join(dir, "src", "index.js");
    executePlan(
      buildPlan({
        cwd: dir,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: entry,
        options: { force: true },
      }),
    );

    execFileSync(process.execPath, [entry], {
      cwd: dir,
      env: { ...CLEAN_ENV, CRUMBTRAIL_KEY: "ctkey_from_real_env" },
      stdio: "pipe",
    });

    expect(seen(dir)[0].authToken).toBe("ctkey_from_real_env");
  });
});
