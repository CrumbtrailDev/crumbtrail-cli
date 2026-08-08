import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { writeEvidenceIndex } from "../evidence-index";

/**
 * The page put the wrong field of the right record on screen. Every request succeeded, the response
 * was correct, and the number beside the label belongs to a different field of the same record.
 */
describe("displayed_field_mismatch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "displayed-field-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const startedAt = 1_700_004_000_000;

  async function candidatesFor(events: BugEvent[]) {
    const index = {
      id: "ses_field",
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: events.at(-1)!.t - events[0].t,
      evts: events.length,
      stats: {},
    };
    return writeEvidenceIndex({ sessionDir: tmpDir, events, index });
  }

  function read(at: number, body: unknown): BugEvent[] {
    return [
      {
        t: at,
        k: "net.req",
        d: { id: 1, requestId: "r1", m: "GET", url: "https://app.test/api/gift-cards/GC-1" },
      },
      {
        t: at + 20,
        k: "net.res",
        d: {
          id: 1,
          requestId: "r1",
          st: 200,
          ct: "application/json",
          body: JSON.stringify(body),
        },
      },
    ];
  }

  function screen(at: number, label: string, value: number): BugEvent {
    return {
      t: at,
      k: "ui.num",
      d: { region: "section", items: [{ label, value, unit: "currency" }] },
    };
  }

  const card = {
    card: {
      code: "GC-1",
      initialCents: 5000,
      balanceCents: 1250,
    },
  };

  // The label matches `balanceCents` by name once the minor-unit suffix is stripped, and the number
  // beside it is `initialCents`. That is the defect and its own fix.
  it("names both the field the label promised and the field it got", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Balance", 50),
    ]);

    const found = candidates.find((c) => c.detector === "displayed_field_mismatch");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("high");
    expect(found?.title).toContain("initialCents");
    expect(found?.title).toContain("balanceCents");
  });

  it("identifies which record was on screen", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Balance", 50),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch")?.anchor
        .message,
    ).toContain("GC-1");
  });

  it("says nothing when the page shows the field its label names", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Balance", 12.5),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch"),
    ).toBeUndefined();
  });

  // Two of the three conditions is a coincidence. A number that matches no field of the record says
  // nothing about which field was read.
  it("says nothing when the displayed number matches no sibling field", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Balance", 99),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch"),
    ).toBeUndefined();
  });

  it("says nothing about a label matching no field at all", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Shipping", 50),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch"),
    ).toBeUndefined();
  });

  // A render that happened before the response arrived cannot have been drawn from it.
  it("ignores a render that preceded the response", async () => {
    const candidates = await candidatesFor([
      screen(startedAt, "Balance", 50),
      ...read(startedAt + 500, card),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch"),
    ).toBeUndefined();
  });

  it("threads the finding to the response it read", async () => {
    const candidates = await candidatesFor([
      ...read(startedAt, card),
      screen(startedAt + 500, "Balance", 50),
    ]);

    expect(
      candidates.find((c) => c.detector === "displayed_field_mismatch")
        ?.causalRole,
    ).not.toBe("isolated");
  });
});
