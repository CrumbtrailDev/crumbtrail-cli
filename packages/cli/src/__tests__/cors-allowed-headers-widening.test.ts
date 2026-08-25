// Wiring a backend and leaving its CORS header allowlist alone wires an app the
// browser refuses to talk to: correlation makes every cross-origin request
// preflighted, and `allowedHeaders: ["Content-Type", "Authorization"]` answers
// that preflight without the three names the SDK now sends. The widening is
// part of the wiring, and it is narrow on purpose — a wrong guess here breaks
// CORS in a second, different way.

import { describe, it, expect } from "vitest";
import {
  CORRELATION_REQUEST_HEADERS,
  corsElsewhereGuidance,
  corsWideningGuidance,
  servesHttp,
  widenCorsAllowedHeaders,
} from "../inject/text";

describe("widenCorsAllowedHeaders", () => {
  it("widens an Express literal array, preserving the app's own headers", () => {
    const source = [
      'import express from "express";',
      'import cors from "cors";',
      "const app = express();",
      'app.use(cors({ origin: "http://localhost:5173", allowedHeaders: ["Content-Type", "Authorization"] }));',
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(true);
    expect(result.needsManual).toBe(false);
    expect(result.text).toContain(
      'allowedHeaders: ["Content-Type", "Authorization", "x-crumbtrail-session-id", "x-crumbtrail-request-id", "traceparent"]',
    );
    expect(result.text).toContain('origin: "http://localhost:5173"');
  });

  it("widens Hono's allowHeaders", () => {
    const source = [
      'import { cors } from "hono/cors";',
      'app.use("*", cors({ allowHeaders: ["Content-Type"] }));',
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(true);
    for (const header of CORRELATION_REQUEST_HEADERS) {
      expect(result.text).toContain(`"${header}"`);
    }
  });

  it("widens the comma separated string form", () => {
    const source = [
      'const cors = require("cors");',
      'app.use(cors({ allowedHeaders: "Content-Type,Authorization" }));',
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.text).toContain(
      'allowedHeaders: "Content-Type,Authorization,x-crumbtrail-session-id,x-crumbtrail-request-id,traceparent"',
    );
  });

  it("refuses to guess at a computed header list, and says so", () => {
    const source = [
      'import cors from "cors";',
      "const allowed = buildHeaders();",
      "app.use(cors({ allowedHeaders: allowed }));",
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("leaves a config with no header list alone: it already echoes the request", () => {
    const source = ['import cors from "cors";', "app.use(cors());"].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(false);
  });

  it("is idempotent", () => {
    const source = [
      'import cors from "cors";',
      'app.use(cors({ allowedHeaders: ["Content-Type"] }));',
    ].join("\n");

    const once = widenCorsAllowedHeaders(source);
    const twice = widenCorsAllowedHeaders(once.text);

    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("ignores an allowedHeaders that has nothing to do with CORS middleware", () => {
    const source = 'const allowedHeaders: string[] = ["a"];';

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(false);
  });

  it("names all three headers in the manual guidance", () => {
    const guidance = corsWideningGuidance();
    for (const header of CORRELATION_REQUEST_HEADERS) {
      expect(guidance).toContain(header);
    }
    expect(guidance).toContain("allowedHeaders");
    expect(guidance).toContain("allowHeaders");
    expect(guidance).toContain("@fastify/cors");
  });

  it("widens @fastify/cors, registered as a plugin", () => {
    const source = [
      'import cors from "@fastify/cors";',
      'await app.register(cors, { origin: "http://localhost:5173", allowedHeaders: ["Content-Type"] });',
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.found).toBe(true);
    expect(result.changed).toBe(true);
    for (const header of CORRELATION_REQUEST_HEADERS) {
      expect(result.text).toContain(`"${header}"`);
    }
  });

  it("widens @fastify/cors registered by dynamic import", () => {
    const source = [
      'app.register(import("@fastify/cors"), { allowedHeaders: ["Content-Type"] });',
    ].join("\n");

    const result = widenCorsAllowedHeaders(source);

    expect(result.changed).toBe(true);
    expect(result.text).toContain("traceparent");
  });

  it("widens @koa/cors", () => {
    const source = [
      'import cors from "@koa/cors";',
      'app.use(cors({ allowHeaders: ["Content-Type"] }));',
    ].join("\n");

    expect(widenCorsAllowedHeaders(source).changed).toBe(true);
  });

  it("reports a file with no CORS middleware as not found", () => {
    const result = widenCorsAllowedHeaders("const app = express();");

    expect(result.found).toBe(false);
    expect(result.changed).toBe(false);
  });

  it("names the headers when the CORS config lives in another file", () => {
    const guidance = corsElsewhereGuidance();

    for (const header of CORRELATION_REQUEST_HEADERS) {
      expect(guidance).toContain(header);
    }
    expect(guidance).toContain("No CORS middleware in this file");
  });
});

// Defect class: a package that never answers HTTP got the whole fifteen line
// CORS lecture with three framework snippets. There is no preflight to block on
// a process nothing calls.
describe("servesHttp", () => {
  it("is false for a bare timer worker with no server dependency", () => {
    expect(
      servesHttp(
        'setInterval(() => console.log("tick"), 5000);',
        JSON.stringify({ name: "ticker", dependencies: { pg: "^8" } }),
      ),
    ).toBe(false);
  });

  it("is true for a listen call, a server import, or a framework dependency", () => {
    expect(servesHttp("app.listen(3000);")).toBe(true);
    expect(servesHttp('import http from "node:http";')).toBe(true);
    expect(servesHttp('const Fastify = require("fastify");')).toBe(true);
    expect(servesHttp('import { serve } from "hono/node-server";')).toBe(true);
    // An entry that only calls a bootstrap living elsewhere: the package's own
    // dependencies are the remaining evidence.
    expect(
      servesHttp(
        "bootstrap();",
        JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }),
      ),
    ).toBe(true);
  });
});
