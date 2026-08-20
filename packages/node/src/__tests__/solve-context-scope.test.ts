import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server";

/**
 * `POST /api/solve-context` is the seam the hosted product locates through.
 * It parses a tenant and project off the request, and until now handed them to
 * an options object the locate engine had never declared — so a ticket in one
 * tenant could be answered with another tenant's captured session.
 *
 * These drive the real endpoint over a real partitioned capture directory,
 * because the defect lived precisely in the wiring between the two.
 */

let tmpDir: string;
let server: http.Server;

/** One finalized session in its partition, carrying a distinct bug that will
 *  score highly against {@link TICKET}. */
function writeSession(tenant: string, app: string, sessionId: string): void {
  const dir = path.join(tmpDir, tenant, app, "2026-08-20", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ tenant, app, sessionId }),
  );
  fs.writeFileSync(
    path.join(dir, "llm.json"),
    JSON.stringify({
      distinctBugs: [
        {
          bugId: `bug-${sessionId}`,
          title: "checkout failed span error",
          severity: "high",
          firstSeen: 1,
          lastSeen: 2,
          representative: {
            detector: "console_error",
            message: "checkout failed span error",
            route: "/checkout",
          },
        },
      ],
    }),
  );
}

const AUTH_TOKEN = "test-token";

const TICKET = {
  title: "checkout failed span error",
  url: "https://acme.atlassian.net/browse/SUP-4211",
  route: "/checkout",
  errorSig: "console_error",
};

async function solveSymptom(
  symptom: Record<string, unknown>,
  options?: Record<string, unknown>,
) {
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/solve-context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-crumbtrail-auth": AUTH_TOKEN,
    },
    body: JSON.stringify({ symptom, ...(options ? { options } : {}) }),
  });
  return { status: res.status, ...((await res.json()) as any) };
}

async function solve(options?: Record<string, unknown>) {
  const { status, ...body } = await solveSymptom(TICKET, options);
  return { status, body };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-solve-scope-"));
  writeSession("tenant-a", "shop", "sess-a");
  writeSession("tenant-b", "shop", "sess-b");
  server = createServer({ port: 0, outputDir: tmpDir, authToken: AUTH_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/solve-context — tenant scope", () => {
  it("honours the scope it is handed and never names another tenant's session", async () => {
    const { status, body } = await solve({
      tenantId: "tenant-a",
      projectId: "shop",
      now: 1_000,
    });
    expect(status).toBe(200);
    expect(body.match.outcome).toBe("matched");
    expect(body.match.sessionId).toBe("sess-a");
    // The whole envelope, not just the top match: an out-of-scope session must
    // not appear as a runner-up candidate either.
    expect(JSON.stringify(body)).not.toContain("sess-b");
  });

  it("narrows to the tenant alone when no project is given", async () => {
    writeSession("tenant-a", "admin", "sess-a-admin");
    const { body } = await solve({ tenantId: "tenant-a", now: 1_000 });
    expect(JSON.stringify(body)).not.toContain("sess-b");
    // Both of tenant A's applications are in range, so the two tie and the
    // decision is ambiguous rather than a fabricated pick.
    expect(body.match.outcome).toBe("ambiguous");
  });

  it("ranks the whole store when no scope is given — the self-hosted case", async () => {
    const { body } = await solve({ now: 1_000 });
    expect(body.match.outcome).toBe("ambiguous");
    expect(JSON.stringify(body)).toContain("sess-b");
  });

  it("refuses a project id with no tenant instead of locating unscoped", async () => {
    const { status, body } = await solve({ projectId: "shop" });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_scope");
  });

  it("refuses a blank id instead of narrowing silently to nothing", async () => {
    for (const options of [
      { tenantId: "  " },
      { tenantId: "tenant-a", projectId: "" },
    ]) {
      const { status, body } = await solve(options);
      expect(status).toBe(400);
      expect(body.code).toBe("invalid_scope");
    }
  });

  it("answers a tenant that has captured nothing with no session at all", async () => {
    const { status, body } = await solve({ tenantId: "tenant-z" });
    expect(status).toBe(200);
    expect(body.match.outcome).toBe("inconclusive");
    expect(body.match.sessionId).toBeUndefined();
  });
});

describe("POST /api/solve-context — the same-route facet", () => {
  it("carries symptom.route through to the score", async () => {
    const scope = { tenantId: "tenant-a", projectId: "shop", now: 1_000 };
    const { title, url, errorSig } = TICKET;
    const withRoute = await solveSymptom(TICKET, scope);
    const withoutRoute = await solveSymptom({ title, url, errorSig }, scope);

    expect(withRoute.match.reasons).toContain("same-route");
    expect(withoutRoute.match.reasons ?? []).not.toContain("same-route");
    expect(
      withRoute.match.confidence - withoutRoute.match.confidence,
    ).toBeCloseTo(0.2, 10);
  });
});
