// What a collector switch does to a session that is already running.
//
// A policy that turns keystroke capture off is usually turned off because
// something is being captured that should not be. Applying that to the config
// and leaving the collector patched and emitting until the next page load
// answers the wrong question: the switch has to reach the running collector.
//
// These tests pin the three claims that makes: OFF stops emission at once and
// leaves what was already buffered alone, ON installs against the config as it
// stands now, and repeating a switch never stacks a second copy of a collector
// on the page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail, OFF_ONLY_COLLECTORS } from "../crumbtrail";
import type { BugEvent, CrumbtrailConfig } from "../types";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

/** Quiet by default; each test turns on only the collector it is about. */
const QUIET = {
  console: false,
  network: false,
  interactions: false,
  keystrokes: false,
  scroll: false,
  visibility: false,
  clipboard: false,
  errors: false,
  performance: false,
  cookies: false,
  storage: false,
  environment: false,
  domSnapshot: false,
  heartbeat: false,
  uiNumbers: false,
  listeners: false,
  eventSource: false,
  webSocket: false,
  workers: false,
  flushIntervalMs: 100_000,
  flushBufferSize: 1_000,
  configPollIntervalMs: 100_000,
  sessionPersistence: "memory",
} as const;

type Internals = {
  config: CrumbtrailConfig;
  collectorTeardowns: Map<string, () => void>;
  envEmitted: boolean;
  applyRemoteConfig: (settings: Record<string, unknown>) => void;
  bus: { tap: (fn: (event: BugEvent) => void) => () => void };
};

function start(overrides: Record<string, unknown> = {}) {
  const logger = Crumbtrail.init({
    transportInstance: makeTransport(),
    ...QUIET,
    ...overrides,
  });
  const internals = logger as unknown as Internals;
  const seen: BugEvent[] = [];
  internals.bus.tap((event) => seen.push(event));
  return {
    logger,
    internals,
    seen,
    kinds: (k: string) => seen.filter((e) => e.k === k),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collector switches applied to a live session", () => {
  it("stops emission at once when a switch turns a collector off", async () => {
    const { logger, internals, kinds } = start({ console: true });

    console.log("before");
    expect(kinds("con")).toHaveLength(1);

    internals.applyRemoteConfig({ collectors: { console: false } });

    console.log("after");
    expect(kinds("con")).toHaveLength(1);
    await logger.stop();
  });

  it("leaves the events captured before the switch in place", async () => {
    const { logger, internals, kinds } = start({ console: true });

    console.log("before");
    internals.applyRemoteConfig({ collectors: { console: false } });

    // The switch says what to capture from here, not what to forget: a report
    // flagged after the switch still gets the evidence that led to it.
    expect(kinds("con")).toHaveLength(1);
    await logger.stop();
  });

  it("restores the patched global rather than leaving an inert wrapper behind", async () => {
    const original = console.log;
    const { logger, internals } = start({ console: true });
    expect(console.log).not.toBe(original);

    internals.applyRemoteConfig({ collectors: { console: false } });

    expect(console.log).toBe(original);
    await logger.stop();
  });

  it("starts a collector that was off at init", async () => {
    const { logger, internals, kinds } = start({ console: false });

    console.log("before");
    expect(kinds("con")).toHaveLength(0);

    internals.applyRemoteConfig({ collectors: { console: true } });

    console.log("after");
    expect(kinds("con")).toHaveLength(1);
    await logger.stop();
  });

  it("installs a started collector against the config as it stands now", async () => {
    const { logger, internals, kinds } = start({ scroll: false });

    // The throttle and the switch arrive on the same poll. A collector built
    // from the init config would run at 0ms and emit on every scroll event.
    internals.applyRemoteConfig({
      scrollThrottleMs: 100_000,
      collectors: { scroll: true },
    });

    document.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));

    expect(kinds("scr")).toHaveLength(1);
    await logger.stop();
  });

  it("does not install a second copy when a policy repeats a switch", async () => {
    const { logger, internals, kinds } = start({ console: true });

    // A poll every minute answering `console: true` for an already-running
    // collector must not stack a second set of patches on `console`.
    for (let i = 0; i < 5; i += 1)
      internals.applyRemoteConfig({ collectors: { console: true } });

    console.log("once");
    expect(kinds("con")).toHaveLength(1);
    expect(internals.collectorTeardowns.size).toBe(1);
    await logger.stop();
  });

  it("leaks nothing across repeated off/on cycles", async () => {
    const original = console.log;
    const { logger, internals, kinds } = start({ console: true });

    for (let i = 0; i < 5; i += 1) {
      internals.applyRemoteConfig({ collectors: { console: false } });
      expect(console.log).toBe(original);
      internals.applyRemoteConfig({ collectors: { console: true } });
    }

    console.log("once");
    expect(kinds("con")).toHaveLength(1);
    expect(internals.collectorTeardowns.size).toBe(1);

    await logger.stop();
    // Shutdown still finds the single live collector and unpatches it.
    expect(console.log).toBe(original);
  });

  it("turns the environment lane off, not just the collector that opens it", async () => {
    const { logger, internals } = start({ environment: true });
    expect(internals.envEmitted).toBe(true);

    internals.applyRemoteConfig({ collectors: { environment: false } });

    // `setEnv` deltas and the flag snapshot both gate on `envEmitted`, so
    // leaving it set would keep resting env data for a session whose policy
    // just said not to.
    expect(internals.envEmitted).toBe(false);

    internals.applyRemoteConfig({ collectors: { environment: true } });
    expect(internals.envEmitted).toBe(true);
    await logger.stop();
  });

  it("ignores switches for settings that have no collector of their own", async () => {
    const { logger, internals } = start({ domSnapshot: false, campaign: false });

    internals.applyRemoteConfig({
      collectors: { domSnapshot: true, campaign: true },
    });

    // Both are read by other code — `domSnapshot` when a bug is flagged,
    // `campaign` by the environment snapshot — so the config value is the whole
    // of the change and nothing is installed.
    expect(internals.config.domSnapshot).toBe(true);
    expect(internals.config.campaign).toBe(true);
    expect(internals.collectorTeardowns.has("domSnapshot")).toBe(false);
    expect(internals.collectorTeardowns.has("campaign")).toBe(false);
    await logger.stop();
  });

  it("does nothing once the session has stopped", async () => {
    const { logger, internals } = start({ console: false });
    await logger.stop();

    internals.applyRemoteConfig({ collectors: { console: true } });

    expect(internals.collectorTeardowns.size).toBe(0);
  });
});

describe("collectors that stop live but start only on the next page load", () => {
  it("names the performance collector and nothing else", () => {
    // A collector joins this set only with a reason recorded next to it. If the
    // set grows, the table in docs/remote-capture-config.md grows with it.
    expect([...OFF_ONLY_COLLECTORS]).toEqual(["performance"]);
  });

  it("stops the performance collector on the poll that turns it off", async () => {
    const { logger, internals } = start({ performance: true });
    expect(internals.collectorTeardowns.has("performance")).toBe(true);

    internals.applyRemoteConfig({ collectors: { performance: false } });

    expect(internals.collectorTeardowns.has("performance")).toBe(false);
    await logger.stop();
  });

  it("defers turning the performance collector back on to the next page load", async () => {
    const { logger, internals } = start({ performance: false });

    internals.applyRemoteConfig({ collectors: { performance: true } });

    // The config carries the policy, so the next page load installs it. This
    // session does not, because `buffered: true` observers would replay the
    // load timeline and the vitals finalizers have already run.
    expect(internals.config.performance).toBe(true);
    expect(internals.collectorTeardowns.has("performance")).toBe(false);
    await logger.stop();
  });
});

describe("ring buffer bounds applied to a live session", () => {
  it("moves the live buffer rather than the next session's", async () => {
    const { logger, internals } = start({ ringBufferMaxEvents: 5_000 });
    const ringBuffer = (logger as unknown as { ringBuffer: { size: number } })
      .ringBuffer;

    internals.applyRemoteConfig({ ringBufferMs: 30_000, ringBufferMaxEvents: 7 });

    const bounds = ringBuffer as unknown as {
      maxMs: number;
      maxEvents: number;
    };
    expect(bounds.maxMs).toBe(30_000);
    expect(bounds.maxEvents).toBe(7);
    await logger.stop();
  });
});
