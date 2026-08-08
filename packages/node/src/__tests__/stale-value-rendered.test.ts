import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { writeEvidenceIndex } from "../evidence-index";

/**
 * Every request succeeded, every response was right, and the screen is wrong. No rule that reads the
 * request plane can see this, because nothing failed there.
 */
describe("stale_value_rendered", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-value-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const startedAt = 1_700_003_000_000;

  async function candidatesFor(events: BugEvent[]) {
    const index = {
      id: "ses_stale",
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: events.at(-1)!.t - events[0].t,
      evts: events.length,
      stats: {},
    };
    return writeEvidenceIndex({ sessionDir: tmpDir, events, index });
  }

  function read(id: number, at: number, body: unknown): BugEvent[] {
    return [
      {
        t: at,
        k: "net.req",
        d: { id, requestId: `r${id}`, m: "GET", url: "https://app.test/api/cards/1" },
      },
      {
        t: at + 20,
        k: "net.res",
        d: {
          id,
          requestId: `r${id}`,
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

  // The server keeps minor units and the screen shows major units. That relation is close enough to
  // universal in payment and ledger APIs that missing it would mean missing the defect everywhere it
  // actually occurs.
  it("reports a balance the page kept after a partial redemption", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { balanceCents: 5000 }),
      ...read(2, startedAt + 1_000, { balanceCents: 1250 }),
      screen(startedAt + 2_000, "Balance", 50),
    ]);

    const found = candidates.find((c) => c.detector === "stale_value_rendered");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("high");
    expect(found?.anchor.message).toContain("1250");
  });

  it("says nothing when the page shows what the server last sent", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { balanceCents: 5000 }),
      ...read(2, startedAt + 1_000, { balanceCents: 1250 }),
      screen(startedAt + 2_000, "Balance", 12.5),
    ]);

    expect(
      candidates.find((c) => c.detector === "stale_value_rendered"),
    ).toBeUndefined();
  });

  // A constant cannot be stale, and a session is full of constants: ids, page sizes, counts.
  it("says nothing about a field that never changed", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { limit: 20 }),
      ...read(2, startedAt + 1_000, { limit: 20 }),
      screen(startedAt + 2_000, "Per page", 20),
    ]);

    expect(
      candidates.find((c) => c.detector === "stale_value_rendered"),
    ).toBeUndefined();
  });

  // A number on screen that matches nothing the server sent is not evidence either way. Reporting it
  // would make the rule fire on every page with an unrelated figure on it.
  it("says nothing about a screen number the responses never carried", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { balanceCents: 5000 }),
      ...read(2, startedAt + 1_000, { balanceCents: 1250 }),
      screen(startedAt + 2_000, "Shipping", 4.99),
    ]);

    expect(
      candidates.find((c) => c.detector === "stale_value_rendered"),
    ).toBeUndefined();
  });

  // A render BEFORE the change is correct at the moment it happened.
  it("does not call a value stale before the value changed", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { balanceCents: 5000 }),
      screen(startedAt + 500, "Balance", 50),
      ...read(2, startedAt + 1_000, { balanceCents: 1250 }),
    ]);

    expect(
      candidates.find((c) => c.detector === "stale_value_rendered"),
    ).toBeUndefined();
  });

  // A finding that reports `isolated` drops out of the incident thread and leaves the causal chain
  // null, which this repository has already paid for twice.
  it("threads the finding to the response it disagrees with", async () => {
    const candidates = await candidatesFor([
      ...read(1, startedAt, { balanceCents: 5000 }),
      ...read(2, startedAt + 1_000, { balanceCents: 1250 }),
      screen(startedAt + 2_000, "Balance", 50),
    ]);

    expect(
      candidates.find((c) => c.detector === "stale_value_rendered")?.causalRole,
    ).not.toBe("isolated");
  });
});
