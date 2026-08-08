import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * The renderer stated "value redacted" for every input, unconditionally, and dropped what the event
 * carried. That was true once. The capture policy now runs typed values through the same classifier
 * as a request body and keeps numbers and short enum-like strings — the comment justifying that work
 * names this exact case, "the ceiling a shopper typed beside the ceiling the request carried", and
 * the bundle a reader got held only the second one.
 */
const scratch: string[] = [];

function inputEvent(d: Record<string, unknown>): BugEvent {
  return {
    t: 1_500,
    k: "inp",
    d: {
      el: { tag: "INPUT", type: "number", path: "input[data-testid=filter-max-price]" },
      ev: "input",
      trusted: true,
      ...d,
    },
  } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-typed-"));
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

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("a typed value the policy kept reaches the reader", () => {
  it("renders the value rather than asserting it was redacted", () => {
    const markdown = renderLlmMarkdown(bundleFor([inputEvent({ val: "0.29" })]));
    expect(markdown).toContain("0.29");
    expect(markdown).not.toContain("value redacted");
  });

  it("says the value was withheld when the policy redacted it", () => {
    const markdown = renderLlmMarkdown(
      bundleFor([
        inputEvent({
          val: "****** ******* *****",
          valSummary: { kind: "input", action: "redacted", reason: "free_text_value" },
        }),
      ]),
    );
    expect(markdown).toContain("withheld by the redaction policy");
    expect(markdown).not.toContain("*******");
  });

  it("treats the policy's own verdict as authoritative over the value's shape", () => {
    // A value that survived masking in form but was redacted in policy must not leak.
    const markdown = renderLlmMarkdown(
      bundleFor([
        inputEvent({
          val: "still-here",
          valSummary: { kind: "input", action: "redacted", reason: "free_text_value" },
        }),
      ]),
    );
    expect(markdown).not.toContain("still-here");
  });

  it("withholds a bare placeholder even with no summary attached", () => {
    const markdown = renderLlmMarkdown(
      bundleFor([inputEvent({ val: "[REDACTED]" })]),
    );
    expect(markdown).toContain("withheld by the redaction policy");
  });
});
