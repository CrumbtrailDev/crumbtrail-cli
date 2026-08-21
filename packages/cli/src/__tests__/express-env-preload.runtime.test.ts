// The Express middleware wiring, RUN in a real Node process.
//
// This is the one regression that string assertions cannot settle, because the
// bug is an ordering bug: `authToken: process.env.CRUMBTRAIL_KEY` is evaluated
// while the entry module runs, and the only thing that loads the project's .env
// used to be autoCapture — reached through a dynamic import that resolves in a
// later microtask, long after every `app.use(...)` line has run. The middleware
// therefore got `undefined`, `sendBackendEvent` omitted the X-Crumbtrail-Auth
// header, and every backend.req.* event was rejected while the wizard reported
// the install as complete.
//
// So: wire a real (stubbed) Express app with the REAL buildPlan + executePlan,
// start it with plain `node` and no --env-file, and read back what the
// middleware was actually constructed with.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlan } from "../inject/recipes";
import { executePlan } from "../inject/executor";
import { cleanup, makeTmpRepo } from "./helpers";

const ENDPOINT = "https://ingest.example.com";

/** A CommonJS Express app plus stub `express` / `crumbtrail-node` packages. */
function makeApp(): string {
  return makeTmpRepo({
    "package.json": JSON.stringify({ name: "app", dependencies: {} }),
    // The key exists ONLY in .env — exactly what the wizard leaves behind.
    ".env": "CRUMBTRAIL_KEY=ctkey_from_env_file\n",
    "index.js": [
      'const express = require("express");',
      "",
      "const app = express();",
      'app.get("/", (_req, res) => res.json({ ok: true }));',
      "app.listen(0);",
      "",
    ].join("\n"),
    "node_modules/express/package.json": JSON.stringify({
      name: "express",
      version: "4.21.2",
      main: "index.js",
    }),
    "node_modules/express/index.js": [
      "function express() {",
      "  const app = {",
      "    use: () => {},",
      "    get: () => {},",
      "    listen: () => ({ close: () => {} }),",
      "  };",
      "  return app;",
      "}",
      "module.exports = express;",
      "",
    ].join("\n"),
    // Records what each middleware factory was handed, so the test can read the
    // token the running app really passed.
    "node_modules/crumbtrail-node/package.json": JSON.stringify({
      name: "crumbtrail-node",
      version: "0.35.0",
      main: "index.js",
    }),
    "node_modules/crumbtrail-node/index.js": [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const record = (kind, options) => {",
      "  fs.appendFileSync(",
      '    path.join(__dirname, "..", "..", "seen.jsonl"),',
      "    JSON.stringify({ kind, authToken: options && options.authToken }) +",
      '      "\\n",',
      "  );",
      "  return () => {};",
      "};",
      "module.exports = {",
      "  autoCapture: () => ({ stop: () => {} }),",
      "  createCrumbtrailExpressMiddleware: (options) =>",
      '    record("request", options),',
      "  createCrumbtrailExpressErrorMiddleware: (options) =>",
      '    record("error", options),',
      "};",
      "",
    ].join("\n"),
  });
}

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanup(dir);
  dir = undefined;
});

describe("wired Express app, running", () => {
  it("hands the middleware the key from .env, with no --env-file", () => {
    dir = makeApp();
    const entry = path.join(dir, "index.js");
    const plan = buildPlan({
      cwd: dir,
      recipe: "express",
      endpoint: ENDPOINT,
      entryFile: entry,
      options: { force: true },
    });
    expect(plan.kind).toBe("rewrite");
    executePlan(plan);

    execFileSync(process.execPath, [entry], {
      cwd: dir,
      // No CRUMBTRAIL_KEY here: the app must find it in .env itself, the way a
      // user's `node index.js` does after the wizard writes the key.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: "pipe",
    });

    const seen = readFileSync(path.join(dir, "seen.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; authToken?: string });
    expect(seen.map((s) => s.kind)).toEqual(["request", "error"]);
    for (const entryRecord of seen) {
      expect(entryRecord.authToken).toBe("ctkey_from_env_file");
    }
  });

  it("never overwrites a key that is already in the environment", () => {
    dir = makeApp();
    const entry = path.join(dir, "index.js");
    const plan = buildPlan({
      cwd: dir,
      recipe: "express",
      endpoint: ENDPOINT,
      entryFile: entry,
      options: { force: true },
    });
    executePlan(plan);

    execFileSync(process.execPath, [entry], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CRUMBTRAIL_KEY: "ctkey_from_real_env",
      },
      stdio: "pipe",
    });

    const first = JSON.parse(
      readFileSync(path.join(dir, "seen.jsonl"), "utf8").trim().split("\n")[0],
    ) as { authToken?: string };
    expect(first.authToken).toBe("ctkey_from_real_env");
  });
});
