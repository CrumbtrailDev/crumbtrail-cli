import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * The environment the LLM bundle exposes is an explicit whitelist, not a passthrough of the
 * `k:'env'` snapshot. Anything the whitelist forgets is captured, shipped, and then silently
 * dropped at bundle time — invisible in both the JSON and the markdown a reading agent gets.
 *
 * These tests pin the fields the whitelist must carry, one section per field, so a later
 * addition can be appended without touching the 83 KB `llm-bundle.test.ts`.
 */
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function envSnapshot(d: Record<string, unknown>): BugEvent {
  return {
    t: 1_500,
    k: "env",
    d: {
      kind: "snapshot",
      userAgent: "Mozilla/5.0 (Macintosh) TestAgent/1.0",
      os: "macOS 15",
      locale: "en-CA",
      timezone: "America/Toronto",
      ...d,
    },
  } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-env-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [],
  } as never);
}

describe("environment: appBuild", () => {
  it("carries the captured release identity into the bundle", () => {
    const bundle = bundleFor([
      envSnapshot({ appBuild: "2026.08.15-a1b2c3" }),
    ]);
    expect(bundle.environment?.appBuild).toBe("2026.08.15-a1b2c3");
  });

  it("renders a release line in the markdown Environment section", () => {
    const markdown = renderLlmMarkdown(
      bundleFor([envSnapshot({ appBuild: "2026.08.15-a1b2c3" })]),
    );
    expect(markdown).toContain("## Environment");
    expect(markdown).toContain("- Release build: 2026.08.15-a1b2c3");
  });

  it("omits the key entirely when the snapshot carried no build", () => {
    const bundle = bundleFor([envSnapshot({})]);
    expect(bundle.environment).not.toBeNull();
    expect(bundle.environment).not.toHaveProperty("appBuild");
    const markdown = renderLlmMarkdown(bundleFor([envSnapshot({})]));
    expect(markdown).not.toContain("Release build");
  });

  it("omits the key rather than emitting an empty string for a blank build", () => {
    const bundle = bundleFor([envSnapshot({ appBuild: "   " })]);
    expect(bundle.environment).not.toHaveProperty("appBuild");
  });

  it("omits the key for a non-string build value", () => {
    const bundle = bundleFor([envSnapshot({ appBuild: 20260815 })]);
    expect(bundle.environment).not.toHaveProperty("appBuild");
  });

  it("truncates an oversized build the same way userAgent and os are truncated", () => {
    // Capture caps this at 120 characters, so only a raw event that bypassed the collector
    // gets here oversized. The bundle bounds it anyway.
    const bundle = bundleFor([envSnapshot({ appBuild: "1.2.3-".repeat(40) })]);
    const appBuild = bundle.environment?.appBuild;
    expect(appBuild).toBeDefined();
    expect(appBuild!.length).toBe(120);
    expect(appBuild!.endsWith("…")).toBe(true);
  });

  it("redacts a token-shaped build rather than resting it in the bundle", () => {
    // `safeText` runs the token-like classifier before truncating, which is exactly the
    // treatment `userAgent` and `os` get. A long opaque blob stamped into `<meta app-build>`
    // is indistinguishable from a leaked key, so it must not survive.
    const opaque = "b".repeat(400);
    const bundle = bundleFor([envSnapshot({ appBuild: opaque })]);
    expect(bundle.environment?.appBuild).toBe("[REDACTED]");
  });

  it("reads the build from the snapshot event, not from a later setEnv delta", () => {
    // Deltas carry only flags/config; device fields come from the snapshot. A delta that
    // happens to carry a build must not overwrite the release the session actually ran.
    const bundle = bundleFor([
      {
        t: 1_400,
        k: "env",
        d: { kind: "delta", appBuild: "delta-build" },
      } as unknown as BugEvent,
      envSnapshot({ appBuild: "snapshot-build" }),
    ]);
    expect(bundle.environment?.appBuild).toBe("snapshot-build");
  });
});
