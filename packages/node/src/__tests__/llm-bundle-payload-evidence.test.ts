import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle } from "../llm-bundle";

// buildLlmBundle reads meta.json off disk, so it needs a real session directory
// rather than a synthetic session object.
const scratch: string[] = [];

function bundleFor(events: BugEvent[], index: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-payload-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 5_000, dur: 4_000, ...index },
    candidates: [],
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const REQUEST_ID = "3be803c2a1fdd199c230b51b97c39360";

function linkTable() {
  return {
    fullStackRequests: {
      summary: {
        frontendRequests: 1,
        backendRequests: 1,
        linked: 1,
        gaps: 0,
        gapTypes: {},
      },
      linked: [
        {
          requestId: REQUEST_ID,
          sessionId: "s1",
          frontend: {
            requestId: REQUEST_ID,
            sessionId: "s1",
            method: "POST",
            url: "http://localhost:7481/api/quotes",
            status: 201,
          },
          backend: {
            requestId: REQUEST_ID,
            sessionId: "s1",
            method: "POST",
            pathname: "/api/quotes",
            statusCode: 201,
          },
        },
      ],
      gaps: [],
    },
  };
}

describe("full-stack request summaries carry payload evidence", () => {
  it("resolves request and response bodies from the session's own events", () => {
    const bundle = bundleFor(
      [
        {
          t: 1_100,
          k: "net.req",
          d: {
            requestId: REQUEST_ID,
            method: "POST",
            url: "http://localhost:7481/api/quotes",
            body: { lane_code: "YYZ-EWR", total_cents: 100 },
          },
        },
        {
          t: 1_200,
          k: "net.res",
          d: {
            requestId: REQUEST_ID,
            status: 201,
            body: { quote: { total_cents: 100, expected_total_cents: 18370 } },
          },
        },
      ] as unknown as BugEvent[],
      linkTable(),
    );

    const linked = bundle.fullStackEvidence.linked[0];
    expect(linked.frontend.requestBody).toContain("YYZ-EWR");
    expect(linked.frontend.responseBody).toContain("18370");
  });

  it("carries the backend response body and its 5xx callsite", () => {
    const bundle = bundleFor(
      [
        {
          t: 1_300,
          k: "backend.req.end",
          d: {
            requestId: REQUEST_ID,
            statusCode: 500,
            responseBody: '{"error":"internal"}',
            responseCallsite: {
              file: "server/src/routes/bookings.js",
              line: 118,
              fn: "documents",
            },
          },
        },
      ] as unknown as BugEvent[],
      linkTable(),
    );

    const backend = bundle.fullStackEvidence.linked[0].backend;
    expect(backend.responseBody).toContain("internal");
    expect(backend.responseCallsite).toMatchObject({
      file: "server/src/routes/bookings.js",
      line: 118,
    });
  });

  it("leaves the summaries alone when no payload was captured", () => {
    const bundle = bundleFor([], linkTable());
    const linked = bundle.fullStackEvidence.linked[0];
    expect(linked.frontend.requestBody).toBeUndefined();
    expect(linked.backend.responseBody).toBeUndefined();
  });
});

describe("database reads keep their correlation key", () => {
  // A 32 hex request id reads as a long opaque token to the free-text path,
  // which used to redact it and collapse every read into one bucket.
  it("keeps an opaque-looking request id readable", () => {
    const bundle = bundleFor([
      {
        t: 1_400,
        k: "db.read",
        d: {
          engine: "sqlite",
          table: "manifest_items",
          pk: { id: 1 },
          row: { id: 1, sku: "PLT-001" },
          requestId: REQUEST_ID,
        },
      },
      {
        t: 1_500,
        k: "db.read",
        d: {
          engine: "sqlite",
          table: "manifest_items",
          pk: { id: 2 },
          row: { id: 2, sku: "PLT-002" },
          requestId: REQUEST_ID,
        },
      },
    ] as unknown as BugEvent[]);

    expect(bundle.databaseReads.map((read) => read.requestId)).toEqual([
      REQUEST_ID,
      REQUEST_ID,
    ]);
  });
});

describe("storage changes reach the bundle", () => {
  it("carries the key and both values", () => {
    const bundle = bundleFor([
      {
        t: 1_600,
        k: "stor",
        d: {
          type: "local",
          op: "set",
          key: "freightline.draft.shipment",
          oldVal: null,
          newVal: '{"lane_code":"YYZ-ORD"}',
        },
      },
    ] as unknown as BugEvent[]);

    expect(bundle.browserEvidence.storageChanges).toHaveLength(1);
    expect(bundle.browserEvidence.storageChanges[0]).toMatchObject({
      area: "local",
      op: "set",
      key: "freightline.draft.shipment",
    });
  });

  it("is an empty list when the session wrote no storage", () => {
    expect(bundleFor([]).browserEvidence.storageChanges).toEqual([]);
  });
});

describe("the full-stack cap keeps the failures", () => {
  // Forty successful polls used to be enough to push a session's only 500 out
  // of the bundle, leaving a reader with a link table that says nothing failed.
  function gapEntry(i: number, statusCode: number) {
    return {
      type: "backend-generated-request-id",
      requestId: `backend_req_${i}`,
      sessionId: "s1",
      backend: {
        requestId: `backend_req_${i}`,
        sessionId: "s1",
        method: "GET",
        pathname: "/api/poll",
        statusCode,
      },
    };
  }

  it("retains a 500 that arrives after the cap is already full", () => {
    const entries = [
      ...Array.from({ length: 45 }, (_, i) => gapEntry(i, 200)),
      gapEntry(99, 500),
    ];
    const bundle = bundleFor([], {
      fullStackRequests: {
        summary: {
          frontendRequests: 0,
          backendRequests: entries.length,
          linked: 0,
          gaps: entries.length,
          gapTypes: {},
        },
        linked: [],
        gaps: entries,
      },
    });

    const kept = bundle.fullStackEvidence.gaps;
    expect(kept).toHaveLength(40);
    expect(kept.some((gap) => gap.backend?.statusCode === 500)).toBe(true);
  });
});
