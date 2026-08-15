import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";

/**
 * Flag variants and flag change history in the LLM bundle.
 *
 * The bundle used to fold every `k:'env'` event's `flagChanges` into one map keyed by flag
 * name, last write wins. That map cannot express the single most diagnostic thing a flag does:
 * flip on, break something, and flip back before the session ended. Both moves collapse onto
 * one entry and the artifact reports the flag as unchanged. These tests pin the ordered
 * sequence that replaced it, and the variant the bundle now names rather than burying inside
 * an opaque flag value.
 */
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function envEvent(t: number, d: Record<string, unknown>): BugEvent {
  return { t, k: "env", d: { kind: "delta", ...d } } as unknown as BugEvent;
}

function snapshot(d: Record<string, unknown> = {}): BugEvent {
  return {
    t: 1_000,
    k: "env",
    d: { kind: "snapshot", os: "macOS 15", locale: "en-CA", ...d },
  } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-flag-hist-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return buildLlmBundle({
    sessionDir: dir,
    events,
    index: { id: "s1", start: 1_000, end: 9_000, dur: 8_000 },
    candidates: [],
  } as never);
}

/** on at +2s, off again at +5s: the exact case a last-write-wins map erases. */
const FLIP_AND_BACK: BugEvent[] = [
  snapshot({ flags: { checkout_v2: false } }),
  envEvent(3_000, {
    flags: { checkout_v2: true },
    flagChanges: {
      checkout_v2: { from: { value: false }, to: { value: true } },
    },
  }),
  envEvent(6_000, {
    flags: { checkout_v2: false },
    flagChanges: {
      checkout_v2: { from: { value: true }, to: { value: false } },
    },
  }),
];

describe("environment: ordered flag change history", () => {
  it("keeps both halves of a mid session flip and flip back, in order", () => {
    const changes = bundleFor(FLIP_AND_BACK).environment?.flagChanges;
    expect(changes).toHaveLength(2);
    expect(changes?.map((c) => [c.flag, c.from?.value, c.to?.value])).toEqual([
      ["checkout_v2", false, true],
      ["checkout_v2", true, false],
    ]);
  });

  it("stamps each change with the event time and the session offset", () => {
    const changes = bundleFor(FLIP_AND_BACK).environment?.flagChanges;
    expect(changes?.map((c) => [c.t, c.offsetMs])).toEqual([
      [3_000, 2_000],
      [6_000, 5_000],
    ]);
    expect(changes?.[0].iso).toBe(new Date(3_000).toISOString());
  });

  it("orders changes chronologically even when events arrive out of order", () => {
    const changes = bundleFor([
      snapshot(),
      envEvent(8_000, {
        flagChanges: { late: { from: { value: 1 }, to: { value: 2 } } },
      }),
      envEvent(2_000, {
        flagChanges: { early: { from: { value: "a" }, to: { value: "b" } } },
      }),
    ]).environment?.flagChanges;
    expect(changes?.map((c) => c.flag)).toEqual(["early", "late"]);
  });

  it("omits an absent side rather than inventing a value for it", () => {
    const changes = bundleFor([
      snapshot(),
      envEvent(2_000, {
        flagChanges: { brand_new: { to: { value: "v2" } } },
      }),
      envEvent(3_000, {
        flagChanges: { retired: { from: { value: true } } },
      }),
    ]).environment?.flagChanges;
    expect(changes?.[0]).not.toHaveProperty("from");
    expect(changes?.[0].to).toEqual({ value: "v2" });
    expect(changes?.[1].from).toEqual({ value: true });
    expect(changes?.[1]).not.toHaveProperty("to");
  });

  it("omits the key entirely when no event carried a change", () => {
    const environment = bundleFor([
      snapshot({ flags: { checkout_v2: true } }),
    ]).environment;
    expect(environment).not.toBeNull();
    expect(environment).not.toHaveProperty("flagChanges");
  });

  it("re-redacts a secret shaped value on both sides of a change", () => {
    const changes = bundleFor([
      snapshot(),
      envEvent(2_000, {
        flagChanges: {
          apiKey: { from: { value: "old-secret" }, to: { value: "new-secret" } },
        },
      }),
    ]).environment?.flagChanges;
    expect(changes?.[0].from?.value).toBe("[REDACTED]");
    expect(changes?.[0].to?.value).toBe("[REDACTED]");
  });
});

describe("environment: flag variants", () => {
  it("names the variant a wrapped flag declaration carries", () => {
    const environment = bundleFor([
      snapshot({
        flags: {
          checkout_v2: { value: true, variant: "test" },
          plain: "pro",
        },
      }),
    ]).environment;
    expect(environment?.flagVariants).toEqual({ checkout_v2: "test" });
  });

  it("takes the variant from a change record when the flag was never re-declared", () => {
    const environment = bundleFor([
      snapshot(),
      envEvent(2_000, {
        flagChanges: {
          pricing: {
            from: { value: "a", variant: "control" },
            to: { value: "b", variant: "treatment" },
          },
        },
      }),
    ]).environment;
    expect(environment?.flagVariants).toEqual({ pricing: "treatment" });
    expect(environment?.flagChanges?.[0].from?.variant).toBe("control");
    expect(environment?.flagChanges?.[0].to?.variant).toBe("treatment");
  });

  it("does not read a variant out of a flag whose value merely is an object", () => {
    // A payload carrying its own `variant` field is not a provider wrapper: the extra key
    // proves the whole object is the flag's value, so reading `variant` off it would report a
    // variant the app never declared.
    const environment = bundleFor([
      snapshot({ flags: { limits: { value: 5, variant: "x", other: 2 } } }),
    ]).environment;
    expect(environment).not.toHaveProperty("flagVariants");
  });

  it("omits the key when no flag declared a variant", () => {
    const environment = bundleFor([
      snapshot({ flags: { checkout_v2: true } }),
    ]).environment;
    expect(environment).not.toHaveProperty("flagVariants");
  });

  it("leaves the flags and config merges last write wins", () => {
    const environment = bundleFor([
      snapshot({ flags: { a: 1, b: 1 }, config: { region: "us" } }),
      envEvent(2_000, { flags: { b: 2 }, config: { region: "eu" } }),
    ]).environment;
    expect(environment?.flags).toEqual({ a: 1, b: 2 });
    expect(environment?.config).toEqual({ region: "eu" });
  });
});

describe("environment markdown: variants and change history", () => {
  it("renders one line per move, in order, with the offset", () => {
    const markdown = renderLlmMarkdown(bundleFor(FLIP_AND_BACK));
    expect(markdown).toContain("## Environment");
    expect(markdown).toContain(
      "- Flags changed during session (values redacted in browser before capture):",
    );
    expect(markdown).toContain("  - +2000ms checkout_v2: false -> true");
    expect(markdown).toContain("  - +5000ms checkout_v2: true -> false");
    expect(markdown.indexOf("+2000ms checkout_v2")).toBeLessThan(
      markdown.indexOf("+5000ms checkout_v2"),
    );
  });

  it("renders the variant next to the value it produced", () => {
    const markdown = renderLlmMarkdown(
      bundleFor([
        snapshot({ flags: { pricing: { value: "b", variant: "treatment" } } }),
        envEvent(2_000, {
          flagChanges: {
            pricing: {
              from: { value: "a", variant: "control" },
              to: { value: "b", variant: "treatment" },
            },
          },
        }),
      ]),
    );
    expect(markdown).toContain("- Flag variants: pricing=treatment");
    expect(markdown).toContain(
      '  - +1000ms pricing: "a" (variant control) -> "b" (variant treatment)',
    );
  });

  it('renders an absent side as "absent"', () => {
    const markdown = renderLlmMarkdown(
      bundleFor([
        snapshot(),
        envEvent(2_000, { flagChanges: { brand_new: { to: { value: 1 } } } }),
      ]),
    );
    expect(markdown).toContain("  - +1000ms brand_new: absent -> 1");
  });

  it("renders no flag lines when the session declared none", () => {
    const markdown = renderLlmMarkdown(bundleFor([snapshot()]));
    expect(markdown).toContain("## Environment");
    expect(markdown).not.toContain("Flag variants");
    expect(markdown).not.toContain("Flags changed during session");
  });
});
