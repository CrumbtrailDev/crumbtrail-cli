import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCompare } from "../run-compare";
import type { BugEvent } from "crumbtrail-core";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-run-compare-"),
  );
  tempRoots.push(root);
  return root;
}

function writeSession(
  root: string,
  id: string,
  totalCents: number,
  options: { release?: string; flag?: boolean } = {},
): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, sessionId: id, release: options.release }),
  );
  const events: BugEvent[] = [
    {
      t: 900,
      k: "env",
      d: {
        kind: "snapshot",
        flags: { newCheckout: options.flag ?? false },
        config: { region: "us" },
      },
    },
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
    { t: 1200, k: "net.res", d: { id: "r1", requestId: "req-1", st: 200 } },
    {
      t: 1300,
      k: "db.diff",
      d: {
        table: "orders",
        op: "insert",
        pk: { id: 1 },
        after: { id: 1, total_cents: totalCents },
        requestId: "req-1",
      },
    },
  ];
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return dir;
}

async function captureStdout(
  run: () => Promise<number>,
): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  try {
    const code = await run();
    return { code, stdout };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runCompare", () => {
  it("prints JSON for two explicit session directories", async () => {
    const root = makeRoot();
    const a = writeSession(root, "sess-a", 1299, {
      release: "R181",
      flag: false,
    });
    const b = writeSession(root, "sess-b", 1399, {
      release: "R182",
      flag: true,
    });

    const { code, stdout } = await captureStdout(() =>
      runCompare([a, b, "--json"]),
    );

    expect(code).toBe(0);
    const comparison = JSON.parse(stdout);
    expect(comparison.schemaVersion).toBe("session-compare.v1");
    expect(comparison.verdict).toBe("regression");
    expect(comparison.a.release).toBe("R181");
    expect(comparison.b.release).toBe("R182");
    expect(comparison.divergences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plane: "db",
          kind: "db.row-value",
          table: "orders",
        }),
        expect.objectContaining({ plane: "env", kind: "env.snapshot" }),
      ]),
    );
  });

  it("resolves bare session ids under --output and writes a markdown report", async () => {
    const root = makeRoot();
    writeSession(root, "sess-a", 1299);
    writeSession(root, "sess-b", 1399);
    const report = path.join(root, "reports", "compare.md");

    const { code, stdout } = await captureStdout(() =>
      runCompare(["sess-a", "sess-b", "--output", root, "--report", report]),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("crumbtrail-server compare - sess-a vs sess-b");
    expect(stdout).toContain("Report:");
    expect(fs.readFileSync(report, "utf8")).toContain(
      "# Session comparison - sess-a vs sess-b",
    );
  });
});
