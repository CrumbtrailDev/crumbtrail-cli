// A README init block is an install path.
//
// Everything the Capture settings page cannot enforce at ingest — the auto flag
// triggers and their tail, baseline sampling, consent mode, client side
// masking, switching session replay on, and live probe delivery — reaches an
// app on the capture config poll and on no other path, and the SDK makes that
// poll only when its init carries `remoteConfig: true`. A reader who copies a
// documented block that points at the hosted cloud and omits the line gets a
// client whose settings page saves and changes nothing, which is exactly the
// defect the installer snippets were fixed for. The snippets are asserted in
// packages/cli/src/__tests__/remote-config-emission.test.ts; the copyable
// documentation needs the same guard, because it is copied just as often and
// nothing else checks it.
//
// Blocks pointing anywhere else are deliberately left alone: the local capture
// server (`crumbtrail-server serve`) does not serve `/api/capture-config`, and
// the poll is fail closed, so turning it on there would stop capture entirely.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Walk up from the working directory to the workspace root.
 *
 * The suite runs both from packages/core and from the repository root, and the
 * happy-dom environment does not leave `import.meta.url` a file URL, so neither
 * anchor is available directly.
 */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("workspace root not found");
    dir = parent;
  }
}

const repoRoot = workspaceRoot();

/** READMEs documenting a browser or webview init against the hosted cloud. */
const DOCS = [
  "README.md",
  "packages/core/README.md",
  "packages/capacitor/README.md",
] as const;

const HOSTED = "https://api.crumbtrail.ai";
const INIT_CALL = /Crumbtrail\.init\(|createCapacitorCrumbtrailAsync\(/;

/** Fenced code blocks, with the 1-based line the fence opens on. */
function fencedBlocks(source: string): { line: number; body: string }[] {
  const lines = source.split("\n");
  const blocks: { line: number; body: string }[] = [];
  let open: number | null = null;
  lines.forEach((text, index) => {
    if (!text.startsWith("```")) return;
    if (open === null) {
      open = index;
      return;
    }
    blocks.push({
      line: open + 1,
      body: lines.slice(open + 1, index).join("\n"),
    });
    open = null;
  });
  return blocks;
}

describe("documented init blocks reach the Capture settings page", () => {
  it.each(DOCS)("%s", (doc) => {
    const source = readFileSync(path.join(repoRoot, doc), "utf8");
    const hostedInits = fencedBlocks(source).filter(
      (block) => block.body.includes(HOSTED) && INIT_CALL.test(block.body),
    );

    // A rename or a restructure that stops matching would silently pass, so
    // assert the blocks are still found before asserting what they contain.
    expect(hostedInits.length).toBeGreaterThan(0);

    const missing = hostedInits
      .filter((block) => !block.body.includes("remoteConfig: true"))
      .map((block) => `${doc}:${block.line}`);
    expect(missing).toEqual([]);
  });
});
