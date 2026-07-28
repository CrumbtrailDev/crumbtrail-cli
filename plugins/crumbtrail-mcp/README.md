# crumbtrail-mcp

Claude Code plugin that connects the Crumbtrail MCP server: complete recorded browser sessions — clicks, requests, backend spans, and the exact database rows that changed — served to Claude as one ranked fix bundle, plus a cross-release regression witness for escaped regressions that fired no error.

Requires `crumbtrail-node` (installed on demand via `npx`) and recorded sessions under `~/.crumbtrail/sessions`. See https://github.com/CrumbtrailDev/crumbtrail-cli for SDK setup.

Ask Claude: "list my Crumbtrail sessions", "get the fix context for session <id>", or "compare session A and B for a regression".

## Manifest locations

The manifest is published twice on purpose, per the [Open Plugins](https://open-plugins.com/plugin-builders/specification) cross-tool compatibility guidance:

- `.claude-plugin/plugin.json` — read by Claude Code
- `.plugin/plugin.json` — vendor-neutral, read by Cursor and other conformant tools

Keep the two in sync when editing. They differ only by the `$schema` line, which Claude Code documents and ignores at load time.
