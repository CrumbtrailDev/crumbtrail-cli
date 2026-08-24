// Wiring a backend and leaving its CORS header allowlist alone wires an app the
// browser refuses to talk to: correlation makes every cross-origin request
// preflighted, and `allowedHeaders: ["Content-Type", "Authorization"]` answers
// that preflight without the three names the SDK now sends. The widening is
// part of the wiring, and it is narrow on purpose — a wrong guess here breaks
// CORS in a second, different way.

import { describe, it, expect } from "vitest";
import {
  CORRELATION_REQUEST_HEADERS,
  corsWideningGuidance,
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
  });
});
