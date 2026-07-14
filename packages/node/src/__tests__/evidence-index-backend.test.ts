import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

describe("buildEvidenceCandidates — backend errors", () => {
  it("surfaces a backend.req.error as a high-severity candidate (score 90)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.req.error",
        d: {
          requestId: "req-1",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          error: {
            name: "TypeError",
            message:
              "Cannot read properties of undefined (reading 'amount_cents')",
          },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "backend_request_error");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(90);
    expect(cand!.anchor.requestId).toBe("req-1");
    expect(cand!.anchor.status).toBe(500);
    expect(cand!.anchor.route).toBe("/api/checkout");
    expect(cand!.anchor.errorCode).toBe("TypeError");
    expect(cand!.anchor.message).toContain("amount_cents");
  });

  it("surfaces a backend.req.end 500 (no thrown error object) as high-severity (score 89)", () => {
    const events: BugEvent[] = [
      {
        t: 2000,
        k: "backend.req.end",
        d: {
          requestId: "req-2",
          method: "GET",
          route: "/api/search",
          statusCode: 500,
          durationMs: 12,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 2000 });
    const cand = candidates.find((c) => c.detector === "backend_http_error");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(89);
    expect(cand!.anchor.status).toBe(500);
  });

  it("surfaces a backend.req.end 4xx as a medium-severity client error (score 66)", () => {
    const events: BugEvent[] = [
      {
        t: 3000,
        k: "backend.req.end",
        d: {
          requestId: "req-3",
          method: "POST",
          route: "/api/cart/items",
          statusCode: 409,
          durationMs: 5,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 3000 });
    const cand = candidates.find(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("medium");
    expect(cand!.score).toBe(66);
    expect(cand!.anchor.status).toBe(409);
  });

  it("does not surface a backend.req.end below 400", () => {
    const events: BugEvent[] = [
      {
        t: 4000,
        k: "backend.req.end",
        d: {
          requestId: "req-4",
          method: "GET",
          route: "/api/products",
          statusCode: 200,
          durationMs: 8,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 4000 });
    expect(
      candidates.find((c) => c.detector?.startsWith("backend_")),
    ).toBeUndefined();
  });

  it("collapses a request that emits both backend.req.error and backend.req.end into one candidate (the error wins)", () => {
    const events: BugEvent[] = [
      {
        t: 5000,
        k: "backend.req.end",
        d: {
          requestId: "req-5",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          durationMs: 20,
        },
      },
      {
        t: 5000,
        k: "backend.req.error",
        d: {
          requestId: "req-5",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          error: { name: "TypeError", message: "boom" },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 5000 });
    const backendCands = candidates.filter((c) =>
      c.detector?.startsWith("backend_"),
    );
    expect(backendCands.length).toBe(1);
    expect(backendCands[0].detector).toBe("backend_request_error");
    expect(backendCands[0].score).toBe(90);
  });

  it("collapses a thrown error (no statusCode) plus a 500 end for the same request into one candidate", () => {
    // Realistic shape: the error event carries no statusCode (thrown before the response is
    // finalized), while the response's end event carries 500. Both must collapse on requestId.
    const events: BugEvent[] = [
      {
        t: 6000,
        k: "backend.req.error",
        d: {
          requestId: "req-6",
          method: "POST",
          route: "/api/checkout",
          error: { name: "TypeError", message: "boom" },
        },
      },
      {
        t: 6010,
        k: "backend.req.end",
        d: {
          requestId: "req-6",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          durationMs: 20,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 6000 });
    const backendCands = candidates.filter((c) =>
      c.detector?.startsWith("backend_"),
    );
    expect(backendCands.length).toBe(1);
    expect(backendCands[0].detector).toBe("backend_request_error");
    expect(backendCands[0].score).toBe(90);
  });
});

describe("buildEvidenceCandidates — console warnings", () => {
  it("surfaces a console.warn as a low-severity candidate (score 50)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "con",
        d: { lv: "warn", msg: "Total mismatch: 233.74000000000004 vs 233.74" },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "console_warning");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("low");
    expect(cand!.score).toBe(50);
    expect(cand!.confidence).toBe("low");
    expect(cand!.anchor.message).toContain("Total mismatch");
  });

  it("does not surface console.warn as an error and does not surface console.log", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "log", msg: "just info" } },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.find((c) => c.detector === "console_warning"),
    ).toBeUndefined();
  });

  it("collapses a warning that re-fires every render into one candidate (earliest anchor)", () => {
    const msg =
      'Warning: Each child in a list should have a unique "key" prop.';
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "warn", msg } },
      { t: 1200, k: "con", d: { lv: "warn", msg } },
      { t: 1400, k: "con", d: { lv: "warn", msg } },
      { t: 1600, k: "con", d: { lv: "warn", msg } },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const warnings = candidates.filter((c) => c.detector === "console_warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].anchor.t).toBe(1000);
  });
});
