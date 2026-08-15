import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { normalizeFlagValue, type BugEvent } from "crumbtrail-core";
import { buildLlmBundle } from "../llm-bundle";

/**
 * The bundle and `crumbtrail-core` must agree about what a flag's value is.
 *
 * The browser SDK normalizes flags through `normalizeFlagValue` before an `env`
 * event is written, but the bundle also reads `d.flags` and `d.flagChanges`
 * produced elsewhere — the OTLP path and the four mobile SDKs both write them.
 * A second copy of the wrapper rule lived in `llm-bundle.ts` and had already
 * drifted from core's on the malformed case below, so the two modules disagreed
 * about what the flag's value even was. There is now one rule, imported.
 */

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function envEvent(d: Record<string, unknown>, t = 2_000): BugEvent {
  return { t, k: "env", d } as unknown as BugEvent;
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-flag-shape-"));
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

/** The shape the two implementations disagreed about: a non-string `variant`. */
const MALFORMED_WRAPPER = { value: "a", variant: 42 };

describe("flag wrapper shape, core and bundle", () => {
  it("core keeps a malformed wrapper whole rather than unwrapping it", () => {
    // Pins the rule the bundle now defers to, so a change on either side is a
    // visible failure rather than a silent divergence.
    expect(normalizeFlagValue(MALFORMED_WRAPPER)).toEqual({
      value: MALFORMED_WRAPPER,
    });
  });

  it("reads a change side by core's rule, not a second one", () => {
    const bundle = bundleFor([
      envEvent({
        flagChanges: {
          checkout_v2: { from: undefined, to: MALFORMED_WRAPPER },
        },
      }),
    ]);

    const changes = bundle.environment?.flagChanges ?? [];
    expect(changes).toHaveLength(1);
    // Core keeps the object whole, so the bundle must too. Reading `"a"` out of
    // it — as the duplicated predicate did — reports a different value for the
    // same flag than the SDK recorded.
    expect(changes[0].to).toEqual({ value: MALFORMED_WRAPPER });
    // And no variant: 42 is not a variant name.
    expect(changes[0].to?.variant).toBeUndefined();
  });

  it("names no variant for a malformed declared wrapper", () => {
    const bundle = bundleFor([
      envEvent({ flags: { checkout_v2: MALFORMED_WRAPPER } }),
    ]);
    expect(bundle.environment?.flagVariants).toBeUndefined();
  });

  it("still unwraps a well formed wrapper on both sides", () => {
    const wrapper = { value: "blue", variant: "test" };
    expect(normalizeFlagValue(wrapper)).toEqual({
      value: "blue",
      variant: "test",
    });

    const bundle = bundleFor([
      envEvent({
        flagChanges: { banner: { from: undefined, to: wrapper } },
      }),
    ]);
    const changes = bundle.environment?.flagChanges ?? [];
    expect(changes[0].to).toEqual({ value: "blue", variant: "test" });
  });

  it("still passes a bare value through untouched", () => {
    const bundle = bundleFor([
      envEvent({ flagChanges: { banner: { from: true, to: false } } }),
    ]);
    const changes = bundle.environment?.flagChanges ?? [];
    expect(changes[0].from).toEqual({ value: true });
    expect(changes[0].to).toEqual({ value: false });
  });

  it("keeps a non-wrapper object whole", () => {
    // `{ value, other }` is a payload, not a wrapper, on both sides.
    const payload = { value: 1, other: 2 };
    expect(normalizeFlagValue(payload)).toEqual({ value: payload });

    const bundle = bundleFor([
      envEvent({
        flagChanges: { pricing: { from: undefined, to: payload } },
      }),
    ]);
    const changes = bundle.environment?.flagChanges ?? [];
    expect(changes[0].to).toEqual({ value: payload });
  });
});
