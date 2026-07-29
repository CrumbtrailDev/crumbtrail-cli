import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// The live case this detector exists for: Kartbug's cancellation notifier
// rendered `Hi undefined, your order #1 was cancelled` into notifications.subject
// (and `total $NaN` into the body), inserted the row, sent the mail, and returned
// 200 everywhere. Nothing structural was wrong — the defect lives entirely in the
// stored value, and the session that observes it usually only READS the row back,
// so the detector must fire on db.read as well as db.diff.

function read(
  t: number,
  requestId: string,
  table: string,
  row: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.read",
    d: { engine: "postgres", table, pk: { id: 1 }, row, requestId, stmt: 1 },
  };
}

function insert(
  t: number,
  requestId: string,
  table: string,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op: "insert", table, pk: { id: 1 }, after, requestId },
  };
}

describe("buildEvidenceCandidates — interpolation_artifact", () => {
  it("fires on a read-back row whose text carries an unrendered template value", () => {
    const events = [
      read(1000, "req-1", "notifications", {
        id: 1,
        order_id: 1,
        recipient: "demo@kartbug.test",
        subject: "Hi undefined, your order #1 was cancelled",
        body: "Hi undefined,\n\nYour order #1 (total $NaN) has been cancelled.",
        status: "sent",
      }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    const hits = candidates.filter((c) => c.detector === "interpolation_artifact");

    // One candidate per column, each naming the artifact it found.
    expect(hits.map((c) => c.title).sort()).toEqual([
      'Interpolation artifact persisted: notifications.body contains "undefined"',
      'Interpolation artifact persisted: notifications.subject contains "undefined"',
    ]);
    for (const hit of hits) {
      expect(hit.severity).toBe("high");
      expect(hit.anchor.requestId).toBe("req-1");
    }
  });

  it("fires on a write's after image, and on NaN / [object Object] / {{x}} fingerprints", () => {
    const events = [
      insert(1000, "req-1", "invoices", { id: 1, note: "Amount due: $NaN" }),
      insert(1001, "req-1", "audit_log", { id: 1, detail: "changed to [object Object]" }),
      insert(1002, "req-1", "emails", { id: 1, subject: "Welcome {{ firstName }}!" }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    const hits = candidates.filter((c) => c.detector === "interpolation_artifact");
    expect(hits.map((c) => c.title).sort()).toEqual([
      'Interpolation artifact persisted: audit_log.detail contains "[object Object]"',
      'Interpolation artifact persisted: emails.subject contains "{{ firstName }}"',
      'Interpolation artifact persisted: invoices.note contains "NaN"',
    ]);
  });

  it("dedupes repeated sightings of the same table+column to one candidate", () => {
    const row = { id: 1, subject: "Hi undefined" };
    const events = [
      read(1000, "req-1", "notifications", row),
      read(2000, "req-2", "notifications", { ...row, id: 2 }),
      insert(3000, "req-3", "notifications", { ...row, id: 3 }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "interpolation_artifact"),
    ).toHaveLength(1);
  });

  it("stays silent on ordinary prose, embedded words, and non-string values", () => {
    const events = [
      read(1000, "req-1", "products", {
        id: 1,
        // "undefined"/"NaN" inside larger words must not match.
        name: "The Undefinedly Great NaNo Kart",
        description: "Behavior here is undefined_behavior per spec",
        price_cents: 19900,
        active: true,
        deleted_at: null,
      }),
      insert(1100, "req-1", "orders", {
        id: 1,
        status: "placed",
        total_cents: 19900,
      }),
    ];

    const candidates = buildEvidenceCandidates(events, { start: 900 });
    expect(
      candidates.filter((c) => c.detector === "interpolation_artifact"),
    ).toHaveLength(0);
  });
});
