import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { McpServer } from "../mcp-server";
import type {
  McpArtifactFailure,
  McpArtifactRead,
  McpReadStore,
  McpSessionListing,
} from "../mcp-read-store";

/**
 * A cloud session whose events were read back as "Session not found".
 *
 * Two separate causes, both live at once:
 *
 *   - `getEvents` asked for `events.ndjson` alone, while a cold hosted session
 *     stores only `events.ndjson.zst`. `getWindow` read the compressed stream
 *     and worked; every tool built on the plain read did not.
 *   - Every failure a read can hit collapsed to `undefined`, and `undefined`
 *     printed one sentence. A session that was still indexing, a token that
 *     had expired and a read limit that had been reached all told the reader
 *     their session id was wrong.
 */

const OUT = path.join(os.tmpdir(), "crumbtrail-read-honesty-never-created");

class StubStore implements McpReadStore {
  constructor(
    private readonly sessionId: string,
    private readonly artifacts: Record<string, Buffer>,
    private readonly failure: McpArtifactFailure = "artifact_missing",
  ) {}

  describe(): string {
    return "the Crumbtrail cloud tenant at https://example.invalid";
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

  async readArtifact(dir: string, name: string): Promise<McpArtifactRead> {
    const body = dir === this.sessionId ? this.artifacts[name] : undefined;
    return body
      ? { ok: true, body }
      : { ok: false, reason: this.failure };
  }

  async statArtifact(dir: string, name: string) {
    const read = await this.readArtifact(dir, name);
    return read.ok ? { bytes: read.body.byteLength, isDir: false } : undefined;
  }
}

async function getEvents(store: McpReadStore, sessionId: string) {
  const server = new McpServer({ outputDir: OUT, readStore: store });
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: "1",
    method: "tools/call",
    params: { name: "getEvents", arguments: { sessionId } },
  });
  return response!.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

const EVENTS = `${JSON.stringify({ t: 1, k: "err", d: { msg: "boom" } })}\n`;

describe("MCP session reads say what actually stopped them", () => {
  it("reads a session whose events are only stored compressed", async () => {
    const store = new StubStore("cold", {
      "events.ndjson.zst": zlib.zstdCompressSync(Buffer.from(EVENTS, "utf-8")),
    });

    const result = await getEvents(store, "cold");

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([
      { t: 1, k: "err", d: { msg: "boom" } },
    ]);
  });

  it("does not call a session missing when only its event stream is", async () => {
    const store = new StubStore("indexed", {
      "index.json": Buffer.from("{}", "utf-8"),
    });

    const result = await getEvents(store, "indexed");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("This session exists");
    expect(result.content[0].text).not.toContain("Session not found");
  });

  it("says a session is still indexing rather than that it is not there", async () => {
    const store = new StubStore("fresh", {}, "session_processing");

    const result = await getEvents(store, "fresh");

    expect(result.content[0].text).toContain("has not been indexed yet");
    expect(result.content[0].text).not.toContain("Session not found");
  });

  it("says the read limit was reached rather than that it is not there", async () => {
    const store = new StubStore("busy", {}, "read_quota_exhausted");

    const result = await getEvents(store, "busy");

    expect(result.content[0].text).toContain("read limit");
    expect(result.content[0].text).toContain("Nothing about the session changed");
  });

  it("says the token cannot read it rather than that it is not there", async () => {
    const store = new StubStore("theirs", {}, "unauthorized");

    const result = await getEvents(store, "theirs");

    expect(result.content[0].text).toContain("token cannot read");
  });

  it("still says not found when the session really is not there, and names where it looked", async () => {
    const store = new StubStore("known", {}, "session_missing");

    const result = await getEvents(store, "gone");

    expect(result.content[0].text).toContain("Session not found");
    expect(result.content[0].text).toContain("example.invalid");
  });
});
