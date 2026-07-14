import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  compareSessions,
  LATENCY_MIN_DELTA_MS,
  LATENCY_MIN_RATIO,
  latencyVerdict,
} from "../compare";
import type { NetworkCall } from "../compare/types";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-compare-latency-"),
  );
  tempRoots.push(root);
  return root;
}

function sessionDir(root: string, name: string, events: BugEvent[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  return dir;
}

function networkEvents(durMs?: number): BugEvent[] {
  const responseD: Record<string, unknown> = {
    id: "r1",
    requestId: "req-1",
    st: 200,
    body: { ok: true },
  };
  if (durMs !== undefined) responseD.dur = durMs;
  return [
    {
      t: 1000,
      k: "clk",
      d: { el: { sig: "checkout-submit", txt: "Place order" } },
    },
    {
      t: 1100,
      k: "net.req",
      d: { id: "r1", requestId: "req-1", method: "POST", url: "/api/checkout" },
    },
    { t: 1200, k: "net.res", d: responseD },
  ];
}

function call(durMs: number | undefined): NetworkCall {
  return { t: 0, method: "GET", route: "/api/items", durMs };
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("latencyVerdict", () => {
  it("requires both absolute delta and ratio thresholds for regressions", () => {
    expect(LATENCY_MIN_DELTA_MS).toBe(250);
    expect(LATENCY_MIN_RATIO).toBe(3);
    expect(latencyVerdict(call(100), call(350))).toBe("regression");
    expect(latencyVerdict(call(0), call(250))).toBe("regression");
    expect(latencyVerdict(call(100), call(349))).toBe("jitter");
    expect(latencyVerdict(call(200), call(500))).toBe("jitter");
  });

  it("ignores missing durations, invalid durations, and faster responses", () => {
    expect(latencyVerdict(call(undefined), call(500))).toBe("none");
    expect(latencyVerdict(call(100), call(undefined))).toBe("none");
    expect(latencyVerdict(call(-1), call(500))).toBe("none");
    expect(latencyVerdict(call(300), call(100))).toBe("none");
  });
});

describe("compareSessions network latency", () => {
  it("emits net.latency only for clear regressions", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", networkEvents(100));
    const b = sessionDir(root, "sess-b", networkEvents(350));

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("regression");
    expect(comparison.divergences).toEqual([
      expect.objectContaining({
        plane: "network",
        kind: "net.latency",
        before: 100,
        after: 350,
      }),
    ]);
    expect(comparison.noise.rules).not.toContain("network.latency-jitter");
  });

  it("suppresses sub-threshold slowdowns as latency jitter noise", async () => {
    const root = makeRoot();
    const a = sessionDir(root, "sess-a", networkEvents(100));
    const b = sessionDir(root, "sess-b", networkEvents(349));

    const comparison = await compareSessions(a, b);

    expect(comparison.verdict).toBe("clean");
    expect(comparison.divergences).toEqual([]);
    expect(comparison.noise.rules).toContain("network.latency-jitter");
  });

  it("does not report missing durations or faster responses", async () => {
    const root = makeRoot();
    const missingDuration = await compareSessions(
      sessionDir(root, "missing-a", networkEvents(100)),
      sessionDir(root, "missing-b", networkEvents()),
    );
    const faster = await compareSessions(
      sessionDir(root, "faster-a", networkEvents(350)),
      sessionDir(root, "faster-b", networkEvents(100)),
    );

    expect(missingDuration.verdict).toBe("clean");
    expect(missingDuration.divergences).toEqual([]);
    expect(missingDuration.noise.rules).not.toContain("network.latency-jitter");
    expect(faster.verdict).toBe("clean");
    expect(faster.divergences).toEqual([]);
    expect(faster.noise.rules).not.toContain("network.latency-jitter");
  });
});
