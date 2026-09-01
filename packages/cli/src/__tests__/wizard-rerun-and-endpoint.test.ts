// Three ways the setup wizard told a user something that was not true, all
// found by putting a person in front of it:
//
//   1. Right after `crumbtrail login --endpoint http://127.0.0.1:19890`, the
//      endpoint prompt offered the hosted cloud as its default and then printed
//      "Using your saved Crumbtrail login for http://127.0.0.1:19890" two lines
//      later. Pressing Enter wired the app to a deployment the run had no
//      login for.
//   2. Re-running on an already wired project reported the ingest key as
//      missing and unnamed, because the skip path withheld the env var name the
//      wiring on disk reads.
//   3. A Hono entry whose CORS lives in `api/src/middleware/cors.ts`, imported
//      at the top of the very file being scanned, was told "No CORS middleware
//      in this file" plus three framework snippets.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmEndpoint, type ParsedArgs, type WizardDeps } from "../cli";
import { buildPlan } from "../inject/recipes";
import type { StoredAuth } from "../auth";
import { fakeInjectIO } from "./helpers";

const HOSTED = "https://api.crumbtrail.ai";
const LOCAL = "http://127.0.0.1:19890";

function endpointDeps(over: {
  saved?: string;
  isTTY?: boolean;
  answer?: string;
}): { deps: WizardDeps; asked: { question: string; def?: string }[] } {
  const asked: { question: string; def?: string }[] = [];
  const deps = {
    env: {},
    isTTY: over.isTTY ?? true,
    prompter: {
      ask: async (question: string, def?: string) => {
        asked.push({ question, def });
        return over.answer ?? def ?? "";
      },
    },
    loadStoredAuth: () =>
      over.saved
        ? ({
            token: "ctcli_x",
            expiresAt: "",
            endpoint: over.saved,
          } satisfies StoredAuth)
        : undefined,
  } as unknown as WizardDeps;
  return { deps, asked };
}

const NO_ARGS = {} as ParsedArgs;

describe("the endpoint prompt defaults to the login this machine holds", () => {
  it("offers the saved login's endpoint, not the hosted cloud", async () => {
    const { deps, asked } = endpointDeps({ saved: LOCAL });
    expect(await confirmEndpoint(NO_ARGS, deps, HOSTED)).toBe(LOCAL);
    expect(asked[0].def).toBe(LOCAL);
    // And says why, so the default is checkable rather than surprising.
    expect(asked[0].question).toContain(`You are logged in to ${LOCAL}`);
  });

  // A first run holds no login, so there is nothing to disambiguate and nothing
  // the person could answer better than the default. Asking anyway opened the
  // product on an infrastructure question fifteen seconds after "set it up in
  // one command". The endpoint is still stated by the wizard, with the flag that
  // changes it, before anything is created.
  it("takes the hosted cloud without asking when there is no saved login", async () => {
    const { deps, asked } = endpointDeps({});
    expect(await confirmEndpoint(NO_ARGS, deps, HOSTED)).toBe(HOSTED);
    expect(asked).toEqual([]);
  });

  // The prompt survives where it earns its keep: a saved login for a different
  // deployment is the case that wired an app to the wrong one.
  it("asks when the saved login points somewhere else", async () => {
    const { deps, asked } = endpointDeps({ saved: LOCAL });
    await confirmEndpoint(NO_ARGS, deps, HOSTED);
    expect(asked).toHaveLength(1);
  });

  it("keeps a stated endpoint, whatever the saved login says", async () => {
    const { deps, asked } = endpointDeps({ saved: LOCAL });
    expect(
      await confirmEndpoint(
        { endpoint: "https://crumbtrail.internal" } as ParsedArgs,
        deps,
        "https://crumbtrail.internal",
      ),
    ).toBe("https://crumbtrail.internal");
    expect(asked).toEqual([]);
  });

  it("takes the same default without a prompt under --yes", async () => {
    const { deps, asked } = endpointDeps({ saved: LOCAL });
    expect(
      await confirmEndpoint({ yes: true } as ParsedArgs, deps, HOSTED),
    ).toBe(LOCAL);
    expect(asked).toEqual([]);
  });

  it("honours an answer typed over the default", async () => {
    const { deps } = endpointDeps({ saved: LOCAL, answer: HOSTED });
    expect(await confirmEndpoint(NO_ARGS, deps, HOSTED)).toBe(HOSTED);
  });
});

describe("a re-run on an already wired project still names its ingest key", () => {
  const CWD = "/proj";
  const p = (...parts: string[]) => path.join(CWD, ...parts);

  it("carries keyEnvVar through the skip-already-wired plan", () => {
    const wired = [
      'import { initCrumbtrail } from "crumbtrail-node";',
      'initCrumbtrail({ endpoint: "https://ingest.example.com", key: process.env.CRUMBTRAIL_KEY, service: "api" });',
      "startServer();",
    ].join("\n");
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({
        name: "api",
        dependencies: {
          "crumbtrail-core": "^0.37.0",
          "crumbtrail-node": "^0.37.0",
        },
      }),
      [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
      [p("node_modules", "crumbtrail-node", "package.json")]: "{}",
      [p(".env")]: "CRUMBTRAIL_KEY=ctkey_existing\n",
      [p("src", "index.ts")]: wired,
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
    // Without this the re-run said "Set your ingest key" and named nothing.
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
  });
});

describe("CORS that lives one import away is not reported as absent", () => {
  const CWD = "/proj";
  const p = (...parts: string[]) => path.join(CWD, ...parts);

  const planFor = (entry: string) =>
    buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: entry,
      }),
    );

  it("softens to a note when the entry imports its CORS from elsewhere", () => {
    const warnings = planFor(
      [
        'import { Hono } from "hono";',
        'import { cors } from "./middleware/cors";',
        "const app = new Hono();",
        "app.use(cors);",
        "export default app;",
      ].join("\n"),
    ).warnings.join("\n");
    expect(warnings).not.toContain("No CORS middleware in this file");
    expect(warnings).toContain("imports CORS from another module");
    expect(warnings).toContain("x-crumbtrail-session-id");
    // The three framework snippets are for a config the wizard has not read.
    expect(warnings).not.toContain("Fastify (@fastify/cors)");
  });

  it("still says CORS is absent when the file mentions none at all", () => {
    const warnings = planFor(
      [
        'import { Hono } from "hono";',
        "const app = new Hono();",
        "export default app;",
      ].join("\n"),
    ).warnings.join("\n");
    expect(warnings).toContain("No CORS middleware in this file");
  });

  it("does not treat registration in a dead branch as installed CORS", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import { testCors } from "./test-cors";',
          "if (false) app.use(testCors())",
          "app.fire()",
        ].join("\n"),
        [p("src", "test-cors.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export function testCors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("test-cors.ts")))
      .toBeFalsy();
  });

  it("does not treat an unresolved conditional policy as installed", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import { testCors } from "./test-cors";',
          'if (process.env.NODE_ENV === "test") app.use(testCors())',
          "serve({ fetch: app.fetch })",
        ].join("\n"),
        [p("src", "test-cors.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export function testCors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("test-cors.ts")))
      .toBeFalsy();
  });

  it("keeps dynamic import bindings lexical to their executed scope", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import { createApp } from "./production";',
          "async function unused() {",
          '  const { createApp } = await import("./test")',
          "  return createApp()",
          "}",
          "createApp()",
        ].join("\n"),
        [p("src", "production.ts")]: [
          'import { prodCors } from "./prod-cors";',
          "export function createApp() {",
          "  app.use(prodCors())",
          "  return app",
          "}",
        ].join("\n"),
        [p("src", "test.ts")]: [
          'import { testCors } from "./test-cors";',
          "export function createApp() { app.use(testCors()); return app }",
        ].join("\n"),
        [p("src", "prod-cors.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export function prodCors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
        [p("src", "test-cors.ts")]: [
          'const ALLOWED_HEADERS = ["X-Test"]',
          "export function testCors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("prod-cors.ts")))
      .toBe(true);
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("test-cors.ts")))
      .toBeFalsy();
  });

  it("does not resolve an imported CORS binding shadowed by a parameter", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import { cors } from "./policy";',
          "function configure(cors) { app.use(cors()) }",
          "configure(noop)",
          "serve({ fetch: app.fetch })",
        ].join("\n"),
        [p("src", "policy.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export function cors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("policy.ts")))
      .toBeFalsy();
  });

  it("does not execute a local factory name shadowed by a parameter", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import cors from "./policy";',
          "function configure() { app.use(cors()) }",
          "function main(configure) { configure() }",
          "main(noop)",
          "serve({ fetch: app.fetch })",
        ].join("\n"),
        [p("src", "policy.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export default function cors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("policy.ts")))
      .toBeFalsy();
  });

  it("follows a called block local factory", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import cors from "./policy";',
          "function main() {",
          "  const configure = () => app.use(cors())",
          "  configure()",
          "}",
          "main()",
          "serve({ fetch: app.fetch })",
        ].join("\n"),
        [p("src", "policy.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export default function cors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("policy.ts")))
      .toBe(true);
  });

  it("does not follow a block factory before its declaration executes", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: [
          'import cors from "./policy";',
          "function main() {",
          "  configure()",
          "  const configure = () => app.use(cors())",
          "}",
          "main()",
          "serve({ fetch: app.fetch })",
        ].join("\n"),
        [p("src", "policy.ts")]: [
          'const ALLOWED_HEADERS = ["Authorization"]',
          "export default function cors() {",
          '  return { "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", ") }',
          "}",
        ].join("\n"),
      }),
    );
    expect(plan.extraEdits?.some((edit) => edit.path.endsWith("policy.ts")))
      .toBeFalsy();
  });

  it("follows a local CORS import and widens a custom header allowlist", () => {
    const entry = [
      'import { createApp } from "./app.js";',
      "createApp();",
    ].join("\n");
    const app = [
      'import { Hono } from "hono";',
      'import { corsOptions } from "./config/cors-options.js";',
      "import {",
      "  corsMiddleware,",
      '} from "./middleware/cors.js";',
      "const app = new Hono();",
      'app.use("*", corsMiddleware());',
      "export default app;",
    ].join("\n");
    const cors = [
      'function unrelated() { const CONFIGURED_HEADERS = ["X-Unrelated"] }',
      'const SAFELISTED_HEADERS = ["Accept", "Content-Type"]',
      'const CONFIGURED_RESPONSE_HEADERS = ["X-Frame-Options"]',
      'const INTERNAL_HEADERS = ["X-Internal"]',
      'const CONFIGURED_HEADERS = ["Authorization", "X-Idempotency-Key"]',
      "const ALLOW_HEADERS = [...SAFELISTED_HEADERS, ...CONFIGURED_HEADERS]",
      "export function internalPolicy(headers) {",
      '  headers["Access-Control-Allow-Headers"] = INTERNAL_HEADERS.join(", ")',
      "}",
      "export function corsMiddleware() {",
      "  return async (_context, next) => {",
      '    headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS.join(", ")',
      "    await next()",
      "  }",
      "}",
    ].join("\n");
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "hono",
        endpoint: "https://ingest.example.com",
        entryFile: p("src", "index.ts"),
        serviceName: "api",
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({ name: "api" }),
        [p("src", "index.ts")]: entry,
        [p("src", "app.ts")]: app,
        [p("src", "config", "cors-options.ts")]:
          'export const corsOptions = { origin: "*" }',
        [p("src", "middleware", "cors.ts")]: cors,
      }),
    );

    const edit = plan.extraEdits?.find((item) =>
      item.path.endsWith("middleware/cors.ts"),
    );
    expect(edit?.content).toContain(
      '"X-Idempotency-Key", "x-crumbtrail-session-id"',
    );
    expect(edit?.content).toContain('"x-crumbtrail-request-id"');
    expect(edit?.content).toContain('"traceparent"');
    expect(edit?.content).not.toContain(
      'SAFELISTED_HEADERS = ["Accept", "Content-Type",',
    );
    expect(edit?.content).toContain(
      'CONFIGURED_RESPONSE_HEADERS = ["X-Frame-Options"]',
    );
    expect(edit?.content).toContain('INTERNAL_HEADERS = ["X-Internal"]');
    expect(edit?.content).toContain(
      'unrelated() { const CONFIGURED_HEADERS = ["X-Unrelated"] }',
    );
    expect(plan.warnings.join("\n")).toContain(
      "Widened the CORS allowed headers",
    );
    expect(plan.warnings.join("\n")).not.toContain(
      "imports CORS from another module",
    );
    expect(plan.warnings.join("\n")).not.toContain(
      "No CORS middleware in this file",
    );
  });
});
