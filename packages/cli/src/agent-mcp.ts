// Connecting the coding agent — the half of setup the wizard used to leave on
// the dashboard.
//
// Crumbtrail's promise is evidence delivered to a coding agent, and until this
// module existed the wizard finished at a dashboard link: a person still had to
// open Settings, mint an agent token and paste JSON into their agent before any
// captured session reached the thing meant to read it. VISION.md's operating
// principle is that a pipeline needing a human click was designed wrong, so the
// wizard mints the token and writes the configuration itself.
//
// The JSON shape is the dashboard's, not a second one invented here. The
// hosted block is the same object `remoteMcpConfig` builds in the main product
// (packages/copy/src/mcp-config.ts): an `http` server at `<cloud>/mcp` with a
// bearer header. A copy exists rather than an import because the CLI is a
// separate published package and `crumbtrail-copy` is not one of its
// dependencies; if the transport there changes, it changes here too.
//
// Pure: no filesystem, no network. The caller owns both.

import path from "node:path";

/** The MCP server name both surfaces write, so a rerun updates one entry. */
export const MCP_SERVER_NAME = "crumbtrail";

/**
 * What stands in for the secret when the configuration is printed rather than
 * written. Identical to the dashboard's `AGENT_TOKEN_PLACEHOLDER`, and the
 * reason nothing is minted on the printing path: a token the wizard cannot put
 * in a file it has established git will not publish has no business being
 * echoed to a terminal, a scrollback buffer or a CI log.
 */
export const AGENT_TOKEN_PLACEHOLDER = "<the ctagt_ token>";

/**
 * The hosted MCP server entry, as the dashboard's Setup page builds it.
 *
 * `token` is the raw `ctagt_` secret. It only ever reaches a file the caller
 * has established git does not follow and does not ignore-by-omission — see
 * `connectCodingAgent` in cli.ts, which applies the same tracked/ignored rules
 * the ingest key write applies to `.env`.
 */
export function hostedMcpServer(
  cloudUrl: string,
  token: string,
): {
  type: "http";
  url: string;
  headers: { Authorization: string };
} {
  return {
    type: "http",
    url: `${cloudUrl.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/** One agent's project-level MCP configuration file. */
export interface AgentConfigTarget {
  /** The agent as a reader names it, for the line the wizard prints. */
  agent: string;
  /** Absolute path to the configuration file. */
  file: string;
  /** Repo-relative path, which is what the wizard prints and gitignores. */
  relPath: string;
  /**
   * The top-level object servers live under. Claude Code and Cursor both use
   * `mcpServers`; VS Code's `.vscode/mcp.json` uses `servers`. Writing the
   * wrong one produces a file the agent parses and ignores.
   */
  configKey: "mcpServers" | "servers";
}

/** The filesystem probes detection needs. `exists` is true for directories. */
export interface AgentConfigIO {
  exists(p: string): boolean;
}

/**
 * Which coding agents this repository is already set up for.
 *
 * Detection only, never a default. A repository with no agent marker gets no
 * new file invented in it: the wizard prints the configuration and the link
 * instead, which is the honest ending for a repo whose agent we cannot name.
 */
export function detectAgentConfigs(
  repoRoot: string,
  io: AgentConfigIO,
): AgentConfigTarget[] {
  const at = (...parts: string[]) => path.join(repoRoot, ...parts);
  const targets: AgentConfigTarget[] = [];
  // Claude Code. `.mcp.json` is its project-scoped server list; `.claude/` and
  // `CLAUDE.md` are the two markers a repo using it always has.
  if (
    io.exists(at(".mcp.json")) ||
    io.exists(at(".claude")) ||
    io.exists(at("CLAUDE.md"))
  ) {
    targets.push({
      agent: "Claude Code",
      file: at(".mcp.json"),
      relPath: ".mcp.json",
      configKey: "mcpServers",
    });
  }
  if (io.exists(at(".cursor"))) {
    targets.push({
      agent: "Cursor",
      file: at(".cursor", "mcp.json"),
      relPath: path.join(".cursor", "mcp.json"),
      configKey: "mcpServers",
    });
  }
  if (io.exists(at(".vscode"))) {
    targets.push({
      agent: "VS Code",
      file: at(".vscode", "mcp.json"),
      relPath: path.join(".vscode", "mcp.json"),
      configKey: "servers",
    });
  }
  return targets;
}

export type McpMergeResult =
  /** The file should be written with this exact content. */
  | { status: "write"; content: string }
  /** A `crumbtrail` server is already configured here, so nothing is touched. */
  | { status: "already-configured" }
  /**
   * The file exists and this cannot reason about it: not JSON, or its server
   * map is not an object. Rewriting it would destroy a configuration this run
   * does not understand.
   */
  | { status: "unreadable"; reason: string };

/**
 * Add the Crumbtrail server to an agent's configuration without disturbing the
 * servers already in it.
 *
 * Never an overwrite. An entry called `crumbtrail` that is already there was
 * put there by someone, possibly pointing at a local capture server on purpose,
 * and replacing it with a hosted one would silently change where their agent
 * reads evidence from.
 */
export function mergeMcpConfig(
  existing: string | null,
  configKey: AgentConfigTarget["configKey"],
  server: unknown,
): McpMergeResult {
  const render = (root: Record<string, unknown>) => ({
    status: "write" as const,
    content: `${JSON.stringify(root, null, 2)}\n`,
  });
  if (existing == null || existing.trim() === "") {
    return render({ [configKey]: { [MCP_SERVER_NAME]: server } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { status: "unreadable", reason: "it is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unreadable", reason: "it does not hold a JSON object" };
  }
  const root = parsed as Record<string, unknown>;
  const current = root[configKey];
  if (current === undefined) {
    return render({ ...root, [configKey]: { [MCP_SERVER_NAME]: server } });
  }
  if (
    typeof current !== "object" ||
    current === null ||
    Array.isArray(current)
  ) {
    return {
      status: "unreadable",
      reason: `its \`${configKey}\` is not an object`,
    };
  }
  const servers = current as Record<string, unknown>;
  if (servers[MCP_SERVER_NAME] !== undefined) {
    return { status: "already-configured" };
  }
  return render({
    ...root,
    [configKey]: { ...servers, [MCP_SERVER_NAME]: server },
  });
}
