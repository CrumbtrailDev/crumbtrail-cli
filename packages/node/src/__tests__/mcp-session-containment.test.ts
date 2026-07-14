import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "../mcp-server";

// CP2 regression guard: session resolution/enumeration now flows through
// defaultSessionStore. These tests prove the containment guarantee still holds
// after that delegation — a session id that would escape outputDir via a
// symlink in the partition tree, or via a `../` traversal id, is refused and
// leaks no artifact.
describe("McpServer session containment (post SessionStore delegation)", () => {
  let outputDir: string;
  let outsideDir: string;
  let server: McpServer;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-out-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-evil-"));
    server = new McpServer({ outputDir });
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return res!.result as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
  }

  function seedOutsideSession(secret: string): string {
    // A fully-formed session sitting OUTSIDE outputDir. If containment ever
    // regresses, its index.json is what would leak.
    const dir = path.join(outsideDir, "secret-session");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "secret-session", start: 1, app: "evil" }),
    );
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({ id: "secret-session", secret }),
    );
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      JSON.stringify({ t: 1, k: "err", d: { msg: secret } }) + "\n",
    );
    return dir;
  }

  it("refuses a session id that resolves through a symlink escaping outputDir", async () => {
    const secret = "TOP-SECRET-LEAK";
    const target = seedOutsideSession(secret);

    // Plant the escaping symlink deep in a finalized partition tree so it can
    // only be reached by the tree walk (which must skip symlinked entries).
    const partition = path.join(outputDir, "acme", "checkout", "2026-06-30");
    fs.mkdirSync(partition, { recursive: true });
    fs.symlinkSync(target, path.join(partition, "leaky"), "dir");

    const index = await callTool("getIndex", { sessionId: "leaky" });
    expect(index.isError).toBe(true);
    expect(index.content[0].text).toBe("Session not found");
    expect(JSON.stringify(index)).not.toContain(secret);

    const events = await callTool("getEvents", { sessionId: "leaky" });
    // getEvents returns an empty list (no artifact) rather than the smuggled events.
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.parse(events.content[0].text as string)).toEqual([]);

    // The escaping session must not surface through enumeration either.
    const sessions = await callTool("listSessions", {});
    expect(JSON.stringify(sessions)).not.toContain(secret);
  });

  it("refuses a `../` traversal session id", async () => {
    const secret = "TRAVERSAL-LEAK";
    seedOutsideSession(secret);

    const traversalId = path.join(
      "..",
      path.basename(outsideDir),
      "secret-session",
    );
    const index = await callTool("getIndex", { sessionId: traversalId });
    expect(index.isError).toBe(true);
    expect(index.content[0].text).toBe("Session not found");
    expect(JSON.stringify(index)).not.toContain(secret);
  });

  it("still resolves a legitimate flat session (control)", async () => {
    const dir = path.join(outputDir, "ses_ok");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "ses_ok", start: 10, app: "test" }),
    );
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({ id: "ses_ok", evts: 0 }),
    );

    const index = await callTool("getIndex", { sessionId: "ses_ok" });
    expect(index.isError).toBeUndefined();
    expect(JSON.parse(index.content[0].text as string).id).toBe("ses_ok");
  });
});
