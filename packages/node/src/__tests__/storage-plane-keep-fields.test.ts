import { describe, it, expect, afterEach } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  getStorageKeepFields,
  sanitizeEventForStorage,
  setStorageKeepFields,
} from "../storage-plane";

function dbDiffEvent(after: Record<string, unknown>): BugEvent {
  return {
    t: 1,
    k: "db.diff",
    d: { table: "reviews", op: "insert", pk: { id: 1 }, after },
  } as unknown as BugEvent;
}

function storedAfter(event: BugEvent): Record<string, unknown> {
  const d = sanitizeEventForStorage(event).d as Record<string, unknown>;
  return d.after as Record<string, unknown>;
}

afterEach(() => setStorageKeepFields([]));

describe("storage keep fields", () => {
  it("redacts a name-matched field by default", () => {
    const after = storedAfter(dbDiffEvent({ body: "great product", rating: 5 }));
    expect(after.body).toBe("[REDACTED]");
    expect(after.rating).toBe(5);
  });

  it("keeps a declared field verbatim", () => {
    setStorageKeepFields(["body"]);
    const after = storedAfter(
      dbDiffEvent({ body: "<img src=x onerror=alert(1)>", rating: 5 }),
    );
    expect(after.body).toBe("<img src=x onerror=alert(1)>");
  });

  it("normalizes the declared name against the stored key", () => {
    setStorageKeepFields([" Postal_Code "]);
    const after = storedAfter(dbDiffEvent({ postalCode: "K1A 0B1" }));
    expect(after.postalCode).toBe("K1A 0B1");
    expect(getStorageKeepFields()).toEqual(["postalcode"]);
  });

  it("still removes a token pasted into a kept field", () => {
    const token = ["sk", "live", "51H8xQ2eZvKYlo2CabcdefghijklmnopQ"].join(
      "_",
    );
    setStorageKeepFields(["body"]);
    const after = storedAfter(dbDiffEvent({ body: `my key is ${token}` }));
    expect(after.body).not.toContain(token);
  });

  it("sweeps a nested object under a kept name in full", () => {
    setStorageKeepFields(["body"]);
    const after = storedAfter(
      dbDiffEvent({ body: { password: "hunter2-super-secret", qty: 2 } }),
    );
    expect(JSON.stringify(after.body)).not.toContain("hunter2-super-secret");
  });

  it("leaves undeclared sensitive names redacted", () => {
    setStorageKeepFields(["body"]);
    const after = storedAfter(
      dbDiffEvent({ body: "kept", password: "hunter2-super-secret" }),
    );
    expect(after.body).toBe("kept");
    expect(after.password).toBe("[REDACTED]");
  });

  it("restores deny-biased defaults when the list is cleared", () => {
    setStorageKeepFields(["body"]);
    setStorageKeepFields([]);
    expect(getStorageKeepFields()).toEqual([]);
    expect(storedAfter(dbDiffEvent({ body: "great product" })).body).toBe(
      "[REDACTED]",
    );
  });
});

// The request payload captured beside the response was swept as free text: a
// live session stored `body` readable and `reqBody` as a bare placeholder, so
// the value the caller SENT — the one that decides an idempotency or a retry
// defect — never reached disk.
describe("backend request payloads", () => {
  function backendEnd(d: Record<string, unknown>): BugEvent {
    return {
      t: 1,
      k: "backend.req.end",
      d: {
        requestId: "req-1",
        method: "POST",
        url: "/api/payroll/approve",
        statusCode: 200,
        redaction: {
          policy: "crumbtrail.browser-redaction.v2",
          fields: [],
          summaries: [
            { kind: "json", action: "summarized", reason: "structured_redaction" },
          ],
        },
        ...d,
      },
    } as unknown as BugEvent;
  }

  it("stores reqBody the same way it stores body", () => {
    setStorageKeepFields(["worker", "period", "hours"]);
    const payload = JSON.stringify({ worker: "dana", period: "2026-03", hours: 3.6 });
    const d = sanitizeEventForStorage(
      backendEnd({ body: payload, reqBody: payload }),
    ).d as Record<string, unknown>;
    expect(d.body).toContain("dana");
    expect(d.reqBody).toBe(d.body);
    expect(d.reqBody).not.toBe("[REDACTED]");
  });

  it("keeps the request payload summary envelope", () => {
    const summary = {
      kind: "json",
      action: "summarized",
      reason: "structured_redaction",
      originalLength: 58,
      redactedFields: 0,
    };
    const d = sanitizeEventForStorage(
      backendEnd({ bodySummary: summary, reqBodySummary: summary }),
    ).d as Record<string, unknown>;
    expect(d.reqBodySummary).toEqual(d.bodySummary);
    expect(d.reqBodySummary).not.toBe("[REDACTED]");
  });
});
