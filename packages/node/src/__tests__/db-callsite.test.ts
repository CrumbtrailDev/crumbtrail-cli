import { describe, it, expect } from "vitest";
import { captureDbCallsite, parseStackFrame } from "../db/callsite";
import { buildCallsitePointer, parseGitHubRepo } from "../code-pointers";
import { buildDbDiffEvent } from "../db";
import type { DbDiffEventData } from "crumbtrail-core";

describe("captureDbCallsite", () => {
  it("reports the calling file and line, not the SDK's own frames", () => {
    const callsite = captureDbCallsite();
    expect(callsite).toBeDefined();
    expect(callsite?.file).toContain("db-callsite.test.ts");
    expect(callsite?.line).toBeGreaterThan(0);
  });

  it("returns a repo-relative path when the root contains the caller", () => {
    const callsite = captureDbCallsite(process.cwd());
    expect(callsite?.file.startsWith("/")).toBe(false);
    expect(callsite?.file.startsWith("..")).toBe(false);
  });

  it("keeps an absolute path when the caller sits outside the root", () => {
    const callsite = captureDbCallsite("/nonexistent-root-for-this-test");
    expect(callsite?.file.startsWith("/")).toBe(true);
  });

  it("rides along on a db.diff without being redacted", () => {
    const event = buildDbDiffEvent({
      engine: "postgres",
      op: "insert",
      table: "orders",
      requestId: "req-1",
      pk: { id: 1 },
      after: { id: 1, total_cents: 19900 },
      callsite: { file: "server/src/services/order-service.js", line: 51 },
    });
    const data = event.d as unknown as DbDiffEventData & {
      callsite?: { file: string; line?: number };
    };
    expect(data.callsite).toEqual({
      file: "server/src/services/order-service.js",
      line: 51,
    });
  });

  it("is absent when the host did not ask for it", () => {
    const event = buildDbDiffEvent({
      engine: "postgres",
      op: "insert",
      table: "orders",
      requestId: "req-1",
      pk: { id: 1 },
      after: { id: 1 },
    });
    expect((event.d as Record<string, unknown>).callsite).toBeUndefined();
  });
});

describe("buildCallsitePointer", () => {
  const binding = {
    repo: "https://github.com/CrumbtrailDev/crumbtrail-playground.git",
    commitSha: "0a32bee",
    resolution: "head" as const,
  };

  it("builds a GitHub permalink from a runtime callsite", () => {
    const pointer = buildCallsitePointer(
      { file: "server/src/services/order-service.js", line: 51 },
      binding,
    );
    expect(pointer).toEqual({
      repo: "CrumbtrailDev/crumbtrail-playground",
      path: "server/src/services/order-service.js",
      line: 51,
      commitSha: "0a32bee",
      permalink:
        "https://github.com/CrumbtrailDev/crumbtrail-playground/blob/0a32bee/server/src/services/order-service.js#L51",
      resolution: "head",
    });
  });

  it("parses owner/name and scp-style remotes too", () => {
    expect(parseGitHubRepo("CrumbtrailDev/crumbtrail-playground")).toBe(
      "CrumbtrailDev/crumbtrail-playground",
    );
    expect(
      parseGitHubRepo("git@github.com:CrumbtrailDev/crumbtrail-playground.git"),
    ).toBe("CrumbtrailDev/crumbtrail-playground");
  });

  it("refuses to guess rather than emit a permalink that will not resolve", () => {
    expect(buildCallsitePointer({ file: "/abs/path.js", line: 1 }, binding)).toBeUndefined();
    expect(buildCallsitePointer({ file: "../outside.js" }, binding)).toBeUndefined();
    expect(
      buildCallsitePointer({ file: "a.js" }, { repo: "not a remote", commitSha: "x" }),
    ).toBeUndefined();
    expect(buildCallsitePointer(undefined, binding)).toBeUndefined();
    expect(buildCallsitePointer({ file: "a.js" }, undefined)).toBeUndefined();
  });
});

describe("captureDbCallsite call chain", () => {
  it("reports the app frames above the innermost one, innermost first", () => {
    const route = () => service();
    const service = () => repo();
    const repo = () => captureDbCallsite(process.cwd());
    const site = route();
    expect(site?.stack?.length).toBeGreaterThan(0);
    const chain = [site!, ...(site!.stack ?? [])].map((frame) => frame.fn);
    expect(chain.join(" < ")).toContain("repo");
    expect(chain.join(" < ")).toContain("service");
  });

  it("caps the chain at the requested depth", () => {
    const a = () => b();
    const b = () => c();
    const c = () => d();
    const d = () => e();
    const e = () => captureDbCallsite(process.cwd(), 30, 2);
    const site = a();
    expect(site?.stack).toHaveLength(1);
  });

  it("omits stack entirely when there is only one app frame", () => {
    const site = captureDbCallsite(process.cwd(), 30, 1);
    expect(site?.stack).toBeUndefined();
  });

  it("never nests a stack inside a stack frame", () => {
    const a = () => b();
    const b = () => captureDbCallsite(process.cwd());
    const site = a();
    for (const frame of site?.stack ?? []) {
      expect(frame.stack).toBeUndefined();
    }
  });
});

describe("V8 frame formats", () => {
  // Regression: `at async file:///app/x.js:1:1` has no function name, so a
  // pattern that sweeps `async` into the function group leaves the location as
  // `async file:///app/x.js` — not a path, not a file:// URL, and it survives
  // path.relative as `server/async file:/app/x.js`. Captured for real; it
  // mislocated every write issued from a bare await in a route handler.
  it.each([
    ["at insertReview (/app/repo.js:5:20)", "/app/repo.js", 5, "insertReview"],
    ["at /app/repo.js:5:20", "/app/repo.js", 5, undefined],
    ["at async createOrder (/app/service.js:22:3)", "/app/service.js", 22, "createOrder"],
    ["at async file:///app/routes/checkout.js:41:20", "/app/routes/checkout.js", 41, undefined],
    ["at file:///app/routes/checkout.js:41:20", "/app/routes/checkout.js", 41, undefined],
  ])("parses %s", (frame, file, line, fn) => {
    const parsed = parseStackFrame(frame);
    expect(parsed?.file).toBe(file);
    expect(parsed?.line).toBe(line);
    expect(parsed?.fn).toBe(fn);
  });
});
