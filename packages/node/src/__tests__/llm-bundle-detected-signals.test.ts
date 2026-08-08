import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * The detectors ran, grouped, and landed in `bundle.json` — and nothing put them in the rendered
 * bundle, so a reader holding `llm.md` and nothing else never saw them. Only the causal tree got
 * through, and that shows a finding solely when it is a ROOT with symptoms attributed to it.
 */
const scratch: string[] = [];

function clickEvent(overrides: Record<string, unknown> = {}): BugEvent {
  return {
    t: 1_500,
    k: "clk",
    d: {
      el: { tag: "DIV", id: "overlay", path: "div[id=overlay]" },
      pos: [10, 10],
      box: { w: 1280, h: 720, viewportPct: 100 },
      covered: [
        { tag: "BUTTON", path: "button[data-testid=checkout]", box: { w: 170, h: 37, viewportPct: 1 } },
      ],
      ...overrides,
    },
  } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-signals-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  const index = { id: "s1", start: 1_000, end: 6_000, dur: 5_000 };
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index,
    // The real detectors, so this proves the whole path from event to rendered section rather than
    // that a hand-written candidate survives formatting.
    candidates: buildEvidenceCandidates(events, index as never),
  } as never);
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("detected signals reach the rendered bundle", () => {
  it("renders a finding that is not a causal root", () => {
    const bundle = bundleFor([clickEvent()]);
    // The premise: this session's finding has no symptom attributed to it, so the causal tree
    // cannot carry it. If that stops being true the test proves nothing.
    expect(bundle.causalTree ?? []).toHaveLength(0);
    expect(
      bundle.distinctBugs.map((bug) => bug.representative.detector),
    ).toContain("click_target_intercepted");

    const markdown = renderLlmMarkdown(bundle);
    expect(markdown).toContain("## Detected Signals");
    expect(markdown).toContain("click_target_intercepted");
    // Attribute VALUES are stripped by the selector sanitizer, so the control is named as
    // `button[data-testid]`. That is the redaction working, not the finding being lost.
    expect(markdown).toContain("over button[data-testid]");
  });

  it("states that a signal is a measurement rather than a verdict", () => {
    const markdown = renderLlmMarkdown(bundleFor([clickEvent()]));
    expect(markdown).toContain("not a verdict");
    // Absence of a signal must not read as absence of a defect.
    expect(markdown).toContain("no evidence either way");
  });

  it("omits the section entirely when nothing was detected", () => {
    const markdown = renderLlmMarkdown(bundleFor([]));
    expect(markdown).not.toContain("## Detected Signals");
  });
});
