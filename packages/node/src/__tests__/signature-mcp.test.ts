import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "../mcp-server";

/**
 * Signature resolve / locate MCP surface (act-by-identity, phase 1: deterministic, resolve-only).
 *
 * resolveSignature(sessionId, signature) -> full interactive-element descriptor from the finalized
 * hot-plane bundle. locateInteractiveElements(sessionId, filter?) -> deterministic ranked list of
 * matching components by identity. Both read the existing interactive-element map; they never
 * recompute signatures, re-parse raw events, or surface raw masked values.
 */
describe("MCP signature resolve / locate surface", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-sig-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function call(name: string, args: Record<string, unknown>) {
    return server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  async function parseResult(name: string, args: Record<string, unknown>) {
    const res = await call(name, args);
    const result = res!.result as any;
    return {
      result,
      parsed: result.isError ? undefined : JSON.parse(result.content[0].text),
    };
  }

  /** Seed a finalized session with a known interactive-element map + signature dictionary. */
  function seedSession(sessionId: string) {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1000, app: "test-app" }),
    );

    fs.writeFileSync(
      path.join(dir, "signatures.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: 1,
            sig: "sig_pay_btn",
            path: "button.pay",
            tag: "button",
            firstSeen: 1500,
            firstEventKind: "clk",
          },
          {
            id: 2,
            sig: "sig_email",
            path: "input.email",
            tag: "input",
            firstSeen: 1200,
            firstEventKind: "inp",
          },
          {
            id: 3,
            sig: "sig_cancel_btn",
            path: "button.cancel",
            tag: "button",
            firstSeen: 1800,
            firstEventKind: "clk",
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(dir, "llm.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "crumbtrail.agent-session-bundle",
        browserEvidence: {
          interactiveElements: [
            {
              sig: "sig_pay_btn",
              path: "button.pay",
              tag: "button",
              txt: "Pay now",
              count: 5,
            },
            {
              sig: "sig_email",
              path: "input.email",
              tag: "input",
              txt: "Email address",
              count: 5,
            },
            {
              sig: "sig_cancel_btn",
              path: "button.cancel",
              tag: "button",
              txt: "Cancel",
              count: 2,
            },
          ],
        },
      }),
    );

    return dir;
  }

  it("registers resolveSignature and locateInteractiveElements", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("resolveSignature");
    expect(names).toContain("locateInteractiveElements");
  });

  it("resolveSignature returns the full descriptor for a known signature", async () => {
    seedSession("s1");
    const { parsed, result } = await parseResult("resolveSignature", {
      sessionId: "s1",
      signature: "sig_pay_btn",
    });
    expect(result.isError).toBeFalsy();
    expect(parsed.kind).toBe("interactive-element");
    expect(parsed.signature).toBe("sig_pay_btn");
    expect(parsed.path).toBe("button.pay");
    expect(parsed.selector).toBe("button.pay");
    expect(parsed.tag).toBe("button");
    expect(parsed.role).toBe("button");
    expect(parsed.label).toBe("Pay now");
    expect(parsed.text).toBe("Pay now");
    expect(parsed.occurrences).toBe(5);
    expect(parsed.firstSeen).toBe(1500);
    expect(parsed.firstEventKind).toBe("clk");
    expect(parsed.affordance).toEqual({ clickable: true, input: false });
  });

  it("resolveSignature marks input affordance for input elements", async () => {
    seedSession("s2");
    const { parsed } = await parseResult("resolveSignature", {
      sessionId: "s2",
      signature: "sig_email",
    });
    expect(parsed.tag).toBe("input");
    expect(parsed.affordance).toEqual({ clickable: false, input: true });
  });

  it("resolveSignature returns a clean error for an unknown signature", async () => {
    seedSession("s3");
    const { result } = await parseResult("resolveSignature", {
      sessionId: "s3",
      signature: "sig_missing",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("resolveSignature returns isError for an empty signature", async () => {
    seedSession("s3e");
    const { result } = await parseResult("resolveSignature", {
      sessionId: "s3e",
      signature: "",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty signature");
  });

  it("resolveSignature returns isError for an unknown session", async () => {
    const { result } = await parseResult("resolveSignature", {
      sessionId: "nope",
      signature: "sig_pay_btn",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("locateInteractiveElements returns a deterministic ranked list (occurrences desc, then label, then signature)", async () => {
    seedSession("s4");
    const { parsed } = await parseResult("locateInteractiveElements", {
      sessionId: "s4",
    });
    expect(parsed.count).toBe(3);
    // sig_email (5, "Email address") and sig_pay_btn (5, "Pay now") tie on occurrences; "Email address" < "Pay now".
    expect(parsed.elements.map((e: any) => e.signature)).toEqual([
      "sig_email",
      "sig_pay_btn",
      "sig_cancel_btn",
    ]);
    expect(parsed.elements[0]).toEqual({
      signature: "sig_email",
      role: "input",
      label: "Email address",
      path: "input.email",
      occurrences: 5,
    });
  });

  it("locateInteractiveElements filters by role/tag", async () => {
    seedSession("s5");
    const { parsed } = await parseResult("locateInteractiveElements", {
      sessionId: "s5",
      role: "button",
    });
    expect(parsed.count).toBe(2);
    expect(parsed.elements.map((e: any) => e.signature)).toEqual([
      "sig_pay_btn",
      "sig_cancel_btn",
    ]);
    expect(parsed.filter.role).toBe("button");
  });

  it("locateInteractiveElements filters by case-insensitive label substring", async () => {
    seedSession("s6");
    const { parsed } = await parseResult("locateInteractiveElements", {
      sessionId: "s6",
      text: "cancel",
    });
    expect(parsed.count).toBe(1);
    expect(parsed.elements[0].signature).toBe("sig_cancel_btn");
  });

  it("locateInteractiveElements respects limit and reports truncation", async () => {
    seedSession("s7");
    const { parsed } = await parseResult("locateInteractiveElements", {
      sessionId: "s7",
      limit: 1,
    });
    expect(parsed.returned).toBe(1);
    expect(parsed.count).toBe(3);
    expect(parsed.truncated).toBe(true);
  });

  it("locateInteractiveElements returns isError for an unknown session", async () => {
    const { result } = await parseResult("locateInteractiveElements", {
      sessionId: "nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("snake_case aliases dispatch to the same handlers", async () => {
    seedSession("s8");
    const resolved = await parseResult("resolve_signature", {
      sessionId: "s8",
      signature: "sig_pay_btn",
    });
    expect(resolved.parsed.signature).toBe("sig_pay_btn");
    const located = await parseResult("locate_interactive_elements", {
      sessionId: "s8",
    });
    expect(located.parsed.count).toBe(3);
  });
});
