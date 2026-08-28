import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_PLACEHOLDER,
  detectAgentConfigs,
  hostedMcpServer,
  mergeMcpConfig,
  MCP_SERVER_NAME,
} from "../agent-mcp";

const ROOT = path.resolve("/repo");
const p = (...parts: string[]) => path.join(ROOT, ...parts);

function io(present: string[]) {
  const set = new Set(present.map((entry) => p(...entry.split("/"))));
  return { exists: (target: string) => set.has(target) };
}

describe("the hosted MCP server entry", () => {
  // The dashboard's Setup page builds this same object beside a freshly minted
  // token (crumbtrail/packages/copy/src/mcp-config.ts). Two shapes for one
  // connection is how one surface keeps working after a transport change while
  // the other quietly stops.
  it("is the shape the dashboard hands out", () => {
    expect(hostedMcpServer("https://api.crumbtrail.ai", "ctagt_abc")).toEqual({
      type: "http",
      url: "https://api.crumbtrail.ai/mcp",
      headers: { Authorization: "Bearer ctagt_abc" },
    });
  });

  it("does not double the slash on an endpoint that carries one", () => {
    expect(hostedMcpServer("http://127.0.0.1:19890/", "ctagt_abc").url).toBe(
      "http://127.0.0.1:19890/mcp",
    );
  });
});

describe("finding the agent this repository already uses", () => {
  it("recognizes Claude Code from any of its three markers", () => {
    for (const marker of [".mcp.json", ".claude", "CLAUDE.md"]) {
      const [target] = detectAgentConfigs(ROOT, io([marker]));
      expect(target.agent).toBe("Claude Code");
      expect(target.file).toBe(p(".mcp.json"));
      expect(target.configKey).toBe("mcpServers");
    }
  });

  it("writes VS Code's own key rather than Claude Code's", () => {
    // `.vscode/mcp.json` holds `servers`, not `mcpServers`. Writing the wrong
    // one produces a file VS Code parses and then ignores, which reads exactly
    // like a working setup that captured nothing.
    const [target] = detectAgentConfigs(ROOT, io([".vscode"]));
    expect(target.relPath).toBe(path.join(".vscode", "mcp.json"));
    expect(target.configKey).toBe("servers");
  });

  it("invents nothing for a repository with no agent in it", () => {
    expect(detectAgentConfigs(ROOT, io(["package.json"]))).toEqual([]);
  });

  it("finds every agent the repository is set up for", () => {
    const found = detectAgentConfigs(ROOT, io([".claude", ".cursor"]));
    expect(found.map((t) => t.agent)).toEqual(["Claude Code", "Cursor"]);
  });
});

describe("adding the server to a configuration that already exists", () => {
  const server = hostedMcpServer("https://api.crumbtrail.ai", "ctagt_abc");

  it("creates the whole file when there is none", () => {
    const merged = mergeMcpConfig(null, "mcpServers", server);
    expect(merged.status).toBe("write");
    expect(
      JSON.parse((merged as { content: string }).content).mcpServers,
    ).toEqual({ [MCP_SERVER_NAME]: server });
  });

  it("keeps every server the reader already configured", () => {
    const existing = JSON.stringify({
      mcpServers: { linear: { command: "npx", args: ["linear-mcp"] } },
    });
    const merged = mergeMcpConfig(existing, "mcpServers", server);
    const parsed = JSON.parse((merged as { content: string }).content);
    expect(Object.keys(parsed.mcpServers).sort()).toEqual([
      MCP_SERVER_NAME,
      "linear",
    ]);
    expect(parsed.mcpServers.linear.command).toBe("npx");
  });

  it("never replaces a crumbtrail entry someone put there on purpose", () => {
    // It may point at a local capture server deliberately. Overwriting it
    // would silently move where that agent reads evidence from.
    const existing = JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { command: "crumbtrail-server" } },
    });
    expect(mergeMcpConfig(existing, "mcpServers", server)).toEqual({
      status: "already-configured",
    });
  });

  it("refuses a file it cannot reason about instead of rewriting it", () => {
    expect(mergeMcpConfig("{ not json", "mcpServers", server).status).toBe(
      "unreadable",
    );
    expect(
      mergeMcpConfig('{"mcpServers": []}', "mcpServers", server).status,
    ).toBe("unreadable");
  });

  it("carries no credential in the printable form", () => {
    const merged = mergeMcpConfig(
      null,
      "mcpServers",
      hostedMcpServer("https://api.crumbtrail.ai", AGENT_TOKEN_PLACEHOLDER),
    );
    expect((merged as { content: string }).content).toContain("ctagt_");
    expect((merged as { content: string }).content).toContain(
      AGENT_TOKEN_PLACEHOLDER,
    );
  });
});
