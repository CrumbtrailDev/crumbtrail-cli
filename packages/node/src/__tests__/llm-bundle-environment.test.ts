import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { BugEvent, EnvSnapshot } from "crumbtrail-core";
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

describe("environment: PostHog-parity context fields", () => {
  it("carries the referrer through the URL redaction path", () => {
    const bundle = bundleFor([
      envSnapshot({
        referrer: "https://news.example.com/story?utm_x=abc#frag",
      }),
    ]);
    // Hash dropped, query values redacted — the arrival path survives, the payload does not.
    expect(bundle.environment?.referrer).toBe(
      "https://news.example.com/story?utm_x=%5BREDACTED%5D",
    );
  });

  it("carries first-party campaign labels", () => {
    const bundle = bundleFor([
      envSnapshot({
        campaign: { source: "newsletter", medium: "email", campaign: "august" },
      }),
    ]);
    expect(bundle.environment?.campaign).toEqual({
      source: "newsletter",
      medium: "email",
      campaign: "august",
    });
  });

  it("omits campaign entirely when no label survived sanitizing", () => {
    const bundle = bundleFor([envSnapshot({ campaign: { source: "  " } })]);
    expect(bundle.environment).not.toHaveProperty("campaign");
  });

  it("carries device display characteristics", () => {
    const bundle = bundleFor([
      envSnapshot({
        device: {
          dpr: 2,
          screen: { w: 2560, h: 1440 },
          orientation: "landscape-primary",
        },
      }),
    ]);
    expect(bundle.environment?.device).toEqual({
      dpr: 2,
      screen: { w: 2560, h: 1440 },
      orientation: "landscape-primary",
    });
  });

  it("drops a malformed screen while keeping the rest of the device", () => {
    const bundle = bundleFor([
      envSnapshot({ device: { dpr: 3, screen: { w: "wide", h: 1440 } } }),
    ]);
    expect(bundle.environment?.device).toEqual({ dpr: 3 });
  });

  it("carries the connection, including a false saveData", () => {
    const bundle = bundleFor([
      envSnapshot({
        connection: {
          effectiveType: "4g",
          downlink: 10,
          rtt: 50,
          saveData: false,
        },
      }),
    ]);
    // `false` is a real reading, not an absent one, so it must survive removeUndefined.
    expect(bundle.environment?.connection).toEqual({
      effectiveType: "4g",
      downlink: 10,
      rtt: 50,
      saveData: false,
    });
  });

  it("carries deviceMemory and hardwareConcurrency as numbers", () => {
    const bundle = bundleFor([
      envSnapshot({ deviceMemory: 8, hardwareConcurrency: 10 }),
    ]);
    expect(bundle.environment?.deviceMemory).toBe(8);
    expect(bundle.environment?.hardwareConcurrency).toBe(10);
  });

  it("omits non-numeric device counters rather than emitting a string", () => {
    const bundle = bundleFor([
      envSnapshot({ deviceMemory: "8", hardwareConcurrency: Number.NaN }),
    ]);
    expect(bundle.environment).not.toHaveProperty("deviceMemory");
    expect(bundle.environment).not.toHaveProperty("hardwareConcurrency");
  });

  it("records every flag move as its own ordered entry across the snapshot and later flag-snapshot events", () => {
    // Changes arrive after the base snapshot, so reading `base` alone would lose them. The
    // third event flips `checkout_v2` back off: a map keyed by flag name would collapse that
    // onto the first move and report the flag as unchanged, so the two entries surviving in
    // order is the assertion, not an incidental detail of it.
    const bundle = bundleFor([
      envSnapshot({}),
      {
        t: 2_000,
        k: "env",
        d: {
          kind: "flag-snapshot",
          flagChanges: { checkout_v2: { from: false, to: true } },
        },
      } as unknown as BugEvent,
      {
        t: 3_000,
        k: "env",
        d: {
          kind: "flag-snapshot",
          flagChanges: { pricing_tier: { from: "a", to: "b" } },
        },
      } as unknown as BugEvent,
      {
        t: 4_000,
        k: "env",
        d: {
          kind: "flag-snapshot",
          flagChanges: { checkout_v2: { from: true, to: false } },
        },
      } as unknown as BugEvent,
    ]);
    expect(bundle.environment?.flagChanges).toEqual([
      {
        t: 2_000,
        iso: "1970-01-01T00:00:02.000Z",
        offsetMs: 1_000,
        flag: "checkout_v2",
        from: { value: false },
        to: { value: true },
      },
      {
        t: 3_000,
        iso: "1970-01-01T00:00:03.000Z",
        offsetMs: 2_000,
        flag: "pricing_tier",
        from: { value: "a" },
        to: { value: "b" },
      },
      {
        t: 4_000,
        iso: "1970-01-01T00:00:04.000Z",
        offsetMs: 3_000,
        flag: "checkout_v2",
        from: { value: true },
        to: { value: false },
      },
    ]);
  });

  it("renders the new fields in the markdown Environment section", () => {
    // A field carried into the JSON but never rendered is still invisible to a reading agent.
    const markdown = renderLlmMarkdown(
      bundleFor([
        envSnapshot({
          referrer: "https://news.example.com/story",
          campaign: { source: "newsletter" },
          device: {
            dpr: 2,
            screen: { w: 2560, h: 1440 },
            orientation: "landscape-primary",
          },
          connection: { effectiveType: "4g", rtt: 50 },
          deviceMemory: 8,
          hardwareConcurrency: 10,
          flagChanges: { checkout_v2: { from: false, to: true } },
        }),
        {
          t: 2_500,
          k: "env",
          d: {
            kind: "flag-snapshot",
            flagChanges: { checkout_v2: { from: true, to: false } },
          },
        } as unknown as BugEvent,
      ]),
    );
    expect(markdown).toContain("- Referrer: https://news.example.com/story");
    expect(markdown).toContain("- Campaign: source=newsletter");
    expect(markdown).toContain("- Device: 2560x1440, dpr 2, landscape-primary");
    expect(markdown).toContain("- Connection: 4g, 50 ms rtt");
    expect(markdown).toContain("- Device memory: 8 GB");
    expect(markdown).toContain("- CPU cores: 10");
    // One bullet per move, in order, each stamped with its offset. A single summary line naming
    // the changed flags would render this on-then-off pair as one entry and lose the flip.
    expect(markdown).toContain(
      [
        "- Flags changed during session (values redacted in browser before capture):",
        "  - +500ms checkout_v2: false -> true",
        "  - +1500ms checkout_v2: true -> false",
      ].join("\n"),
    );
  });
});

/**
 * Runtime companion to the `_envWhitelistIsExhaustive` sentinel in `llm-bundle.ts`.
 *
 * The sentinel proves every `EnvSnapshot` key has a matching key on `LlmBundleEnvironment`. It
 * cannot prove `buildEnvironment` actually populates it — a declared-but-never-assigned field
 * type-checks fine and drops silently at runtime. This test closes that half.
 */
describe("environment: whitelist exhaustiveness", () => {
  /**
   * Keys that are captured on the wire but deliberately never surfaced as a bundle field.
   *
   * Widening this array is the reviewable act: adding an entry here is how a field becomes an
   * accepted drop instead of an accident, so every entry carries its reason.
   */
  const NOT_SURFACED_IN_THE_BUNDLE: Array<keyof EnvSnapshot> = [
    // Wire-level discriminator between snapshot / delta / flag-snapshot. The bundle merges all
    // three into one environment object, so the discriminator has no meaning afterwards.
    "kind",
    // Browser-side redaction bookkeeping. It describes the capture pipeline, not the app under
    // test, and an agent reasoning about the defect has no use for it.
    "redaction",
  ];

  // `Required<EnvSnapshot>` is the second half of the guard: adding a field to `EnvSnapshot`
  // without adding it here is a compile error in this file.
  const everyField: Required<EnvSnapshot> = {
    kind: "snapshot",
    userAgent: "Mozilla/5.0 (Macintosh) TestAgent/1.0",
    browser: { name: "Chrome", version: "141.0" },
    os: "macOS 15",
    viewport: { w: 1440, h: 900 },
    locale: "en-CA",
    timezone: "America/Toronto",
    appBuild: "2026.08.15-a1b2c3",
    flags: { checkout_v2: true },
    config: { region: "eu" },
    referrer: "https://news.example.com/story",
    campaign: {
      source: "newsletter",
      medium: "email",
      campaign: "august",
      term: "bugs",
      content: "cta",
    },
    device: {
      dpr: 2,
      screen: { w: 2560, h: 1440 },
      orientation: "landscape-primary",
    },
    connection: { effectiveType: "4g", downlink: 10, rtt: 50, saveData: false },
    deviceMemory: 8,
    hardwareConcurrency: 10,
    flagChanges: { checkout_v2: { from: false, to: true } },
    redaction: { policy: "browser-v2" },
  };

  it("round trips every EnvSnapshot key that is not an explicit exclusion", () => {
    const bundle = bundleFor([
      { t: 1_500, k: "env", d: everyField } as unknown as BugEvent,
    ]);
    const environment = bundle.environment;
    expect(environment).not.toBeNull();

    const missing = (
      Object.keys(everyField) as Array<keyof EnvSnapshot>
    ).filter(
      (key) =>
        !NOT_SURFACED_IN_THE_BUNDLE.includes(key) &&
        !Object.prototype.hasOwnProperty.call(environment, key),
    );
    expect(missing).toEqual([]);
  });

  it("does not surface the excluded keys", () => {
    const bundle = bundleFor([
      { t: 1_500, k: "env", d: everyField } as unknown as BugEvent,
    ]);
    for (const key of NOT_SURFACED_IN_THE_BUNDLE) {
      expect(bundle.environment).not.toHaveProperty(key);
    }
  });
});
