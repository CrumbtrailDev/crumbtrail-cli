import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle } from "../llm-bundle";

/**
 * `flagBug` now emits a third `k:'env'` kind, `flag-snapshot`, carrying the resolved flag and
 * config state at flag time.
 *
 * `buildEnvironment` picks its base event by `kind === 'snapshot'`, so the risk a third literal
 * introduces is a cross-package one a core-only test cannot see: if the selection ever loosened
 * to "the first env event" or to a prefix/substring match, the flag-snapshot would win the base
 * slot and every device field in the bundle would go missing. These tests pin the selection and
 * pin that the new kind still contributes its flags.
 */
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function envEvent(t: number, d: Record<string, unknown>): BugEvent {
  return { t, k: "env", d } as unknown as BugEvent;
}

function deviceSnapshot(): BugEvent {
  return envEvent(1_500, {
    kind: "snapshot",
    userAgent: "Mozilla/5.0 (Macintosh) TestAgent/1.0",
    os: "macOS 15",
    locale: "en-CA",
    timezone: "America/Toronto",
    flags: { newCheckout: true, legacyNav: false },
  });
}

function bundleFor(events: BugEvent[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-bundle-flagsnap-"));
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

describe("environment: flag-snapshot does not displace the base snapshot", () => {
  it("keeps device fields when a flag-snapshot follows the snapshot", () => {
    const bundle = bundleFor([
      deviceSnapshot(),
      envEvent(4_000, {
        kind: "flag-snapshot",
        flags: { newCheckout: false, legacyNav: false },
      }),
    ]);

    // The device fields live only on the base snapshot. If the flag-snapshot had been chosen as
    // the base, every one of these would be undefined.
    expect(bundle.environment?.os).toBe("macOS 15");
    expect(bundle.environment?.locale).toBe("en-CA");
    expect(bundle.environment?.timezone).toBe("America/Toronto");
    expect(bundle.environment?.userAgent).toContain("TestAgent/1.0");
  });

  it("keeps device fields when the flag-snapshot arrives FIRST in the event list", () => {
    // Event order is not guaranteed to be the order the reader gets. Selection is by `kind`,
    // not by position, and the `?? envEvents[0]` fallback must not be what answers here.
    const bundle = bundleFor([
      envEvent(4_000, { kind: "flag-snapshot", flags: { newCheckout: false } }),
      deviceSnapshot(),
    ]);

    expect(bundle.environment?.os).toBe("macOS 15");
    expect(bundle.environment?.timezone).toBe("America/Toronto");
  });

  it("merges the flag-snapshot's resolved flags over the earlier declaration", () => {
    const bundle = bundleFor([
      deviceSnapshot(),
      envEvent(3_000, {
        kind: "delta",
        flags: { newCheckout: false },
        flagChanges: {
          newCheckout: { from: { value: true }, to: { value: false } },
        },
      }),
      envEvent(4_000, {
        kind: "flag-snapshot",
        flags: { newCheckout: false, legacyNav: false },
      }),
    ]);

    // The value at flag time wins, and the key the flag-snapshot restates untouched survives.
    expect(bundle.environment?.flags).toEqual({
      newCheckout: false,
      legacyNav: false,
    });
    // The delta's move is the only one reported, and it keeps the stamp that lets an agent line
    // it up against the error timeline. The later flag-snapshot restates the resolved value but
    // reports no move, so it must not add an entry of its own.
    expect(bundle.environment?.flagChanges).toEqual([
      {
        t: 3_000,
        iso: "1970-01-01T00:00:03.000Z",
        offsetMs: 2_000,
        flag: "newCheckout",
        from: { value: true },
        to: { value: false },
      },
    ]);
  });

  it("still produces an environment when a flag-snapshot is the only env event", () => {
    const bundle = bundleFor([
      envEvent(4_000, { kind: "flag-snapshot", flags: { newCheckout: false } }),
    ]);

    // No base snapshot exists, so the fallback correctly uses the only event there is: flags
    // survive rather than the whole environment collapsing to null.
    expect(bundle.environment).not.toBeNull();
    expect(bundle.environment?.flags).toEqual({ newCheckout: false });
  });
});
