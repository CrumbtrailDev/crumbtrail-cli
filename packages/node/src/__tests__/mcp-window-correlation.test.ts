import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BugEvent } from "crumbtrail-core";
import { McpServer } from "../mcp-server";
import type {
  McpReadStore,
  McpSessionListing,
} from "../mcp-read-store";

/**
 * The getWindowCorrelation MCP tool.
 *
 * The scoring itself is covered by window-correlation.test.ts. What is proved
 * here is the tool contract: it finds the planted change, it errors on an
 * unknown session exactly as getWindow does, it respects maxTokens like every
 * other budgeted tool, and — the one that cannot be caught by reading the code
 * casually — it reads the cold stream through the read store rather than
 * through fs, which is what makes it work in hosted mode.
 */

const T0 = 5_000;
const T1 = 6_000;

/**
 * Baseline: 12 `net.res` and 14 `err` over the four seconds before t0.
 * Highlight: 20 `net.res` and 12 `err` in the one second from t0.
 *
 * Both kinds have to clear `MIN_VOLUME_EVENTS` on their COMBINED count for the
 * volume scorer to run at all, which is why `err` carries a baseline rather
 * than being a pure highlight spike.
 *
 * `net.res` is the louder of the two spikes by construction, so it must rank
 * first; `err` is the second row, which is what the budget test needs something
 * to drop. Every `net.res` duration and status is identical in both windows, so
 * the KS scorer has nothing to find and no distribution row may survive. A
 * fixture that moved volume and distribution together would pass even if one of
 * the two scorers were silently dead.
 */
function spikeEvents(): BugEvent[] {
  const events: BugEvent[] = [];
  for (let index = 0; index < 12; index += 1) {
    events.push({
      t: 1_000 + index * 330,
      k: "net.res",
      d: { id: `base_${index}`, st: 200, dur: 100 },
    });
  }
  for (let index = 0; index < 20; index += 1) {
    events.push({
      t: T0 + index * 40,
      k: "net.res",
      d: { id: `hot_${index}`, st: 200, dur: 100 },
    });
  }
  for (let index = 0; index < 14; index += 1) {
    events.push({ t: 1_100 + index * 280, k: "err", d: { msg: "boom" } });
  }
  for (let index = 0; index < 12; index += 1) {
    events.push({ t: T0 + index * 80, k: "err", d: { msg: "boom" } });
  }
  return events;
}

function ndjson(events: BugEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/**
 * A read store with no filesystem behind it at all.
 *
 * This is the hosted shape in miniature: `RemoteMcpReadStore` serves artifact
 * bytes over HTTP and nothing the tool asks for exists on disk. Any `fs` read
 * inside the tool therefore answers "Session not found" here, while working
 * perfectly on a developer's laptop.
 */
class InMemoryReadStore implements McpReadStore {
  readonly reads: string[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly artifacts: Record<string, string>,
  ) {}

  describe(): string {
    return "an in-memory test store";
  }

  async listSessions(): Promise<McpSessionListing> {
    return {
      sessions: [{ id: this.sessionId, dir: this.sessionId }],
      truncated: false,
    };
  }

  async resolveSessionDir(sessionId: string): Promise<string> {
    return sessionId;
  }

  async readArtifact(
    sessionDir: string,
    name: string,
  ): Promise<Buffer | undefined> {
    this.reads.push(`${sessionDir}/${name}`);
    if (sessionDir !== this.sessionId) return undefined;
    const artifact = this.artifacts[name];
    return artifact === undefined ? undefined : Buffer.from(artifact, "utf-8");
  }

  async statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined> {
    const buffer = await this.readArtifact(sessionDir, name);
    return buffer === undefined
      ? undefined
      : { bytes: buffer.byteLength, isDir: false };
  }
}

describe("getWindowCorrelation", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-wc-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function callTool(
    target: McpServer,
    args: Record<string, unknown>,
  ): Promise<{
    result: { isError?: boolean; content: Array<{ text: string }> };
    parsed: any;
  }> {
    const response = await target.handleMessage({
      jsonrpc: "2.0",
      id: "wc",
      method: "tools/call",
      params: { name: "getWindowCorrelation", arguments: args },
    });
    const result = response!.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return {
      result,
      parsed: result.isError ? undefined : JSON.parse(result.content[0].text),
    };
  }

  function seedSpikeSession(sessionId: string): void {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1_000, app: "test-app" }),
    );
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      ndjson(spikeEvents()),
    );
  }

  it("is advertised in tools/list with its correlation caveat", async () => {
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
    });
    const tools = (
      response!.result as {
        tools: Array<{ name: string; description: string }>;
      }
    ).tools;
    const tool = tools.find((entry) => entry.name === "getWindowCorrelation");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/CORRELATION and not a cause/);

    // The snake_case alias is generated mechanically from the TOOLS array, so
    // it answers only if the descriptor really was appended there.
    seedSpikeSession("spike");
    const aliased = await server.handleMessage({
      jsonrpc: "2.0",
      id: "alias",
      method: "tools/call",
      params: {
        name: "get_window_correlation",
        arguments: { sessionId: "spike", t0: T0, t1: T1 },
      },
    });
    expect((aliased!.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it("returns the spiking kind as the top row", async () => {
    seedSpikeSession("spike");
    const { parsed } = await callTool(server, {
      sessionId: "spike",
      t0: T0,
      t1: T1,
    });

    expect(parsed.baseline).toEqual({ t0: 1_000, t1: T0, events: 26 });
    expect(parsed.highlight).toEqual({ t0: T0, t1: T1, events: 32 });
    expect(parsed.rows[0]).toMatchObject({
      dimension: "volume",
      kind: "net.res",
      field: "count",
      scorer: "volume-delta",
      direction: "increase",
      highlightStat: 20,
    });
    expect(parsed.rows[0].pValue).toBeLessThan(0.01);
    // The durations never moved, so no distribution row may survive.
    expect(
      parsed.rows.some((row: any) => row.dimension === "distribution"),
    ).toBe(false);
    expect(parsed.caveat).toMatch(/correlation, not a cause/);
  });

  it("returns isError for an unknown session, like getWindow", async () => {
    const { result } = await callTool(server, {
      sessionId: "nope",
      t0: T0,
      t1: T1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("truncates with a dropReport under maxTokens", async () => {
    seedSpikeSession("spike");
    const full = await callTool(server, {
      sessionId: "spike",
      t0: T0,
      t1: T1,
    });
    expect(full.parsed.rows.length).toBeGreaterThan(1);
    expect(full.parsed.truncated).toBe(false);

    const { parsed } = await callTool(server, {
      sessionId: "spike",
      t0: T0,
      t1: T1,
      maxTokens: 255,
    });
    expect(parsed.returned).toBeLessThan(full.parsed.count);
    expect(parsed.rows).toHaveLength(parsed.returned);
    expect(parsed.count).toBe(full.parsed.count);
    expect(parsed.truncated).toBe(true);
    expect(parsed.dropReport).toBeDefined();
    expect(parsed.dropReport.message).toMatch(/rows/);
    // Refs identify a dropped row by the dimension it scored, and they are
    // listed in the order the rows were ranked, strongest first.
    expect(parsed.dropReport.droppedRefs).toEqual(["net.res.count", "err.count"]);
    expect(parsed.budgetSatisfied).toBe(true);
    expect(parsed.tokenEstimate).toBeLessThanOrEqual(255);

    // One token more than the whole response costs and nothing is dropped, so
    // the trimming above is the budget working rather than rows going missing.
    const roomy = await callTool(server, {
      sessionId: "spike",
      t0: T0,
      t1: T1,
      maxTokens: 500,
    });
    expect(roomy.parsed.returned).toBe(full.parsed.count);
    expect(roomy.parsed.dropReport).toBeUndefined();
    expect(roomy.parsed.truncated).toBe(false);
  });

  it("answers through a store with no filesystem behind it", async () => {
    // The hosted proof. `outputDir` points at a directory that does not exist
    // and is never created, so the only way to reach the events is the store.
    const absentDir = path.join(tmpDir, "not-created");
    expect(fs.existsSync(absentDir)).toBe(false);
    const store = new InMemoryReadStore("hosted", {
      "meta.json": JSON.stringify({ id: "hosted", start: 1_000 }),
      "events.ndjson": ndjson(spikeEvents()),
    });
    const hosted = new McpServer({ outputDir: absentDir, readStore: store });

    const { result, parsed } = await callTool(hosted, {
      sessionId: "hosted",
      t0: T0,
      t1: T1,
    });

    expect(result.isError).toBeUndefined();
    expect(parsed.rows[0]).toMatchObject({
      dimension: "volume",
      kind: "net.res",
      highlightStat: 20,
    });
    expect(store.reads).toContain("hosted/events.ndjson");
    expect(fs.existsSync(absentDir)).toBe(false);
  });

  it("clamps baselineMultiplier and rejects a non numeric window", async () => {
    seedSpikeSession("spike");
    const { parsed } = await callTool(server, {
      sessionId: "spike",
      t0: T0,
      t1: T1,
      baselineMultiplier: 9_999,
    });
    expect(parsed.baselineMultiplier).toBe(50);

    const { result } = await callTool(server, { sessionId: "spike", t0: T0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("numeric t0 and t1");
  });
});
