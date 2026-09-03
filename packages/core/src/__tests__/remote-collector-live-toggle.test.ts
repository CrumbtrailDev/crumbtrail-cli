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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail, OFF_ONLY_COLLECTORS } from "../crumbtrail";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { UI_NUM_EVENT_KIND } from "../types";
import { UI_NUM_SETTLE_MS } from "../collectors/ui-numbers";

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
  poisonedCollectors: Set<string>;
  envEmitted: boolean;
  applyRemoteConfig: (settings: Record<string, unknown>) => void;
  bus: {
    tap: (fn: (event: BugEvent) => void) => () => void;
    flush: () => void;
  };
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
  it("live-toggles storage failure hooks when the remote trigger changes", async () => {
    const failure = new DOMException("private database", "UnknownError");
    const firstRequest = new EventTarget() as EventTarget & {
      error?: unknown;
    };
    firstRequest.error = failure;
    const pendingRequest = new EventTarget() as EventTarget & {
      error?: unknown;
    };
    pendingRequest.error = failure;
    const factory = {
      open: vi.fn((_name: string) => firstRequest),
    };
    const originalOpen = factory.open;
    const cacheFailure = new DOMException(
      "private cache",
      "QuotaExceededError",
    );
    const cache = {
      put: vi.fn(() => Promise.reject(cacheFailure)),
    };
    let resolvePendingCache: (value: typeof cache) => void = () => {};
    const pendingCacheResult = new Promise<typeof cache>((resolve) => {
      resolvePendingCache = resolve;
    });
    const cacheStorage = {
      open: vi.fn((_name: string) => Promise.resolve(cache)),
      delete: vi.fn(() => Promise.resolve(false)),
      has: vi.fn(() => Promise.resolve(false)),
      match: vi.fn(() => Promise.resolve(undefined)),
      keys: vi.fn(() => Promise.resolve([])),
    };
    const originalCacheOpen = cacheStorage.open;
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("caches", cacheStorage);
    const { logger, internals, kinds } = start({ storage: true });

    expect(internals.config.autoFlagOnStorageFailure).toBe(false);
    expect(factory.open).toBe(originalOpen);

    internals.applyRemoteConfig({ triggers: { storageFailure: true } });
    expect(factory.open).not.toBe(originalOpen);
    factory.open("private-db").dispatchEvent(new Event("error"));
    expect(
      kinds("stor").filter((event) => event.d.type === "idb"),
    ).toHaveLength(1);

    const activeCache = await cacheStorage.open("private-cache");
    await expect(activeCache.put()).rejects.toBe(cacheFailure);
    await Promise.resolve();
    expect(
      kinds("stor").filter(
        (event) => event.d.type === "cache" && event.d.op === "put",
      ),
    ).toHaveLength(1);

    originalOpen.mockReturnValue(pendingRequest);
    const pendingIdb = factory.open("pending-db");
    originalCacheOpen.mockReturnValueOnce(pendingCacheResult);
    const pendingCache = cacheStorage.open("pending-cache");

    internals.applyRemoteConfig({ triggers: { storageFailure: false } });
    expect(factory.open).toBe(originalOpen);
    expect(cacheStorage.open).toBe(originalCacheOpen);
    pendingRequest.dispatchEvent(new Event("error"));
    resolvePendingCache(cache);
    await pendingIdb;
    await pendingCache;
    await expect(cache.put()).rejects.toBe(cacheFailure);
    await Promise.resolve();
    const secondRequest = new EventTarget() as EventTarget & {
      error?: unknown;
    };
    secondRequest.error = failure;
    factory.open.mockReturnValue(secondRequest);
    factory.open("private-db").dispatchEvent(new Event("error"));
    expect(
      kinds("stor").filter((event) => event.d.type === "idb"),
    ).toHaveLength(1);
    expect(
      kinds("stor").filter(
        (event) => event.d.type === "cache" && event.d.op === "put",
      ),
    ).toHaveLength(1);
    await logger.stop();
  });

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

  it("restarts a collector an earlier poll turned off", async () => {
    const { logger, internals, kinds } = start({ console: true });

    internals.applyRemoteConfig({ collectors: { console: false } });
    console.log("while off");
    expect(kinds("con")).toHaveLength(0);

    internals.applyRemoteConfig({ collectors: { console: true } });

    console.log("after");
    expect(kinds("con")).toHaveLength(1);
    await logger.stop();
  });

  it("never starts a collector the application left off at init", async () => {
    const { logger, internals, kinds } = start({ console: false });

    internals.applyRemoteConfig({ collectors: { console: true } });

    console.log("after");
    expect(kinds("con")).toHaveLength(0);
    expect(internals.config.console).toBe(false);
    expect(internals.collectorTeardowns.has("console")).toBe(false);
    await logger.stop();
  });

  it("installs a restarted collector against the config as it stands now", async () => {
    const { logger, internals, kinds } = start({ scroll: true });

    internals.applyRemoteConfig({ collectors: { scroll: false } });

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
    const { logger, internals } = start({ domSnapshot: true, campaign: true });

    internals.applyRemoteConfig({
      collectors: { domSnapshot: false, campaign: false },
    });

    // Both are read by other code — `domSnapshot` when a bug is flagged,
    // `campaign` by the environment snapshot — so the config value is the whole
    // of the change and there is nothing to tear down.
    expect(internals.config.domSnapshot).toBe(false);
    expect(internals.config.campaign).toBe(false);
    expect(internals.collectorTeardowns.has("domSnapshot")).toBe(false);
    expect(internals.collectorTeardowns.has("campaign")).toBe(false);
    await logger.stop();
  });

  it("does nothing once the session has stopped", async () => {
    const { logger, internals } = start({ console: true });
    await logger.stop();
    expect(internals.collectorTeardowns.size).toBe(0);

    internals.applyRemoteConfig({ collectors: { console: false } });
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
    const { logger, internals } = start({ performance: true });

    internals.applyRemoteConfig({ collectors: { performance: false } });
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

    internals.applyRemoteConfig({
      ringBufferMs: 30_000,
      ringBufferMaxEvents: 7,
    });

    const bounds = ringBuffer as unknown as {
      maxMs: number;
      maxEvents: number;
    };
    expect(bounds.maxMs).toBe(30_000);
    expect(bounds.maxEvents).toBe(7);
    await logger.stop();
  });

  it("records a capture gap counting the events a shrink evicted", async () => {
    const { logger, internals, kinds } = start({
      console: true,
      ringBufferMaxEvents: 5_000,
    });
    const ringBuffer = (logger as unknown as { ringBuffer: { size: number } })
      .ringBuffer;
    for (let i = 0; i < 6; i += 1) console.log(`event ${i}`);
    internals.bus.flush();
    expect(ringBuffer.size).toBe(6);

    internals.applyRemoteConfig({ ringBufferMaxEvents: 2 });
    expect(ringBuffer.size).toBe(2);

    // Evidence never leaves in silence: the shrink was asked for, the loss it
    // cost is still the difference between the session and the report cut from
    // it, so the session says how many events went.
    const gaps = kinds("capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d).toMatchObject({
      reason: "retention_reduced",
      droppedEventCount: 4,
    });
    await logger.stop();
  });

  it("records no gap when a shrink evicts nothing", async () => {
    const { logger, internals, kinds } = start({
      console: true,
      ringBufferMaxEvents: 5_000,
    });
    console.log("one");
    internals.bus.flush();

    internals.applyRemoteConfig({ ringBufferMaxEvents: 100 });

    expect(kinds("capture_gap")).toHaveLength(0);
    await logger.stop();
  });

  it("keeps the bus cap and the buffer cap on one ceiling", async () => {
    const { logger, internals } = start({ ringBufferMaxEvents: 5_000 });
    const bus = (logger as unknown as { bus: { maxBufferedEvents: number } })
      .bus;

    // `setMaxBufferedEvents` refuses anything at or below zero, so a bound the
    // buffer took and the bus refused would leave the two disagreeing.
    internals.applyRemoteConfig({ ringBufferMaxEvents: 0 });
    expect(bus.maxBufferedEvents).toBe(5_000);
    expect(internals.config.ringBufferMaxEvents).toBe(5_000);

    internals.applyRemoteConfig({ ringBufferMaxEvents: 12 });
    expect(bus.maxBufferedEvents).toBe(12);
    await logger.stop();
  });
});

// A throttle or a size cap changed by a poll used to be written to the config
// and read by nobody: each collector snapshotted its value at install, so the
// new number reached the next page load rather than the session the policy was
// answering about. These pin the live read.
describe("throttles and size caps applied to collectors already running", () => {
  it("throttles keystrokes at the value the poll carried", async () => {
    const { logger, internals, kinds } = start({
      keystrokes: true,
      keystrokeThrottleMs: 0,
    });

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "b" }));
    expect(kinds("key")).toHaveLength(2);

    internals.applyRemoteConfig({ keystrokeThrottleMs: 100_000 });

    document.dispatchEvent(new KeyboardEvent("keyup", { key: "c" }));
    expect(kinds("key")).toHaveLength(2);
    await logger.stop();
  });

  it("throttles scrolls at the value the poll carried", async () => {
    const { logger, internals, kinds } = start({
      scroll: true,
      scrollThrottleMs: 0,
    });

    document.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
    expect(kinds("scr")).toHaveLength(2);

    internals.applyRemoteConfig({ scrollThrottleMs: 100_000 });

    document.dispatchEvent(new Event("scroll"));
    expect(kinds("scr")).toHaveLength(2);
    await logger.stop();
  });

  it("caps clipboard text at the length the poll carried", async () => {
    const { logger, internals, kinds } = start({
      clipboard: true,
      clipboardMaxLength: 500,
    });

    internals.applyRemoteConfig({ clipboardMaxLength: 10 });

    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "x".repeat(100) },
    });
    document.body.dispatchEvent(paste);

    const events = kinds("clip");
    expect(events).toHaveLength(1);
    expect(String(events[0].d.txt)).toHaveLength(10);
    await logger.stop();
  });

  it("caps storage values at the length the poll carried", async () => {
    const { logger, internals, kinds } = start({ storage: true });

    internals.applyRemoteConfig({ storageValueMaxLength: 10 });
    localStorage.setItem("greeting", "x".repeat(100));

    const writes = kinds("stor").filter((event) => event.d.op === "set");
    expect(writes).toHaveLength(1);
    // A stored value is redacted whole, so the cap shows in the summary the
    // event carries rather than in the length of what it kept.
    expect(writes[0].d.newValSummary).toMatchObject({
      reason: "storage_value_too_large",
      originalLength: 100,
      limit: 10,
    });

    localStorage.removeItem("greeting");
    await logger.stop();
  });
});

// A poll replaces `config.redaction` with a new object rather than mutating the
// one that is there, so a collector holding the array it found at install keeps
// scanning against a deny list the policy has already moved on from.
describe("deny fields applied to a running ui.num collector", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const realSetTimeout = setTimeout;

  async function settle(internals: Internals): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      vi.advanceTimersByTime(UI_NUM_SETTLE_MS);
    }
    internals.bus.flush();
  }

  function labels(events: BugEvent[]): string[] {
    return events.flatMap((event) =>
      ((event.d.items ?? []) as Array<{ label: string }>).map(
        (item) => item.label,
      ),
    );
  }

  it("stops emitting a denied label without reinstalling the collector", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Subtotal</dt><dd>$199.00</dd>
        <dt>Invoice ref</dt><dd>4021</dd>
      </dl>`;

    const { logger, internals, kinds } = start({ uiNumbers: true });
    await settle(internals);
    expect(labels(kinds(UI_NUM_EVENT_KIND))).toContain("Invoice ref");
    const installed = internals.collectorTeardowns.get("uiNumbers");

    internals.applyRemoteConfig({
      redaction: { denyFields: ["invoice ref"] },
    });

    // Change the region so the collector re-scans and re-emits it.
    document.querySelector("dd")!.textContent = "$249.00";
    const before = kinds(UI_NUM_EVENT_KIND).length;
    await settle(internals);

    const emitted = kinds(UI_NUM_EVENT_KIND).slice(before);
    expect(emitted.length).toBeGreaterThan(0);
    expect(labels(emitted)).not.toContain("Invoice ref");
    // Same collector throughout: the deny list reached it, it was not restarted.
    expect(internals.collectorTeardowns.get("uiNumbers")).toBe(installed);
    await logger.stop();
  });

  it("honours a deny field that arrives on the poll that starts the collector", async () => {
    document.body.innerHTML = `
      <dl class="totals">
        <dt>Subtotal</dt><dd>$199.00</dd>
        <dt>Invoice ref</dt><dd>4021</dd>
      </dl>`;

    const { logger, internals, kinds } = start({ uiNumbers: true });
    internals.applyRemoteConfig({ collectors: { uiNumbers: false } });

    // Redaction is applied before the collector switches, so the collector this
    // poll starts scans against the deny list this poll carried.
    internals.applyRemoteConfig({
      redaction: { denyFields: ["invoice ref"] },
      collectors: { uiNumbers: true },
    });
    const before = kinds(UI_NUM_EVENT_KIND).length;
    await settle(internals);

    expect(labels(kinds(UI_NUM_EVENT_KIND).slice(before))).not.toContain(
      "Invoice ref",
    );
    await logger.stop();
  });
});

// A cleanup that throws part way leaves some of its patches in place and some
// restored, and nothing outside it can tell which. Installing over that stacks
// a second wrapper on whatever survived.
describe("a collector whose teardown throws", () => {
  it("is refused for the rest of the session", async () => {
    const { logger, internals, kinds } = start({ scroll: true });
    const real = internals.collectorTeardowns.get("scroll")!;
    internals.collectorTeardowns.set("scroll", () => {
      real();
      throw new Error("half restored");
    });

    internals.applyRemoteConfig({ collectors: { scroll: false } });
    expect(internals.poisonedCollectors.has("scroll")).toBe(true);

    internals.applyRemoteConfig({ collectors: { scroll: true } });

    expect(internals.collectorTeardowns.has("scroll")).toBe(false);
    document.dispatchEvent(new Event("scroll"));
    expect(kinds("scr")).toHaveLength(0);
    await logger.stop();
  });

  it("leaves the rest of the session capturing", async () => {
    const { logger, internals, kinds } = start({
      scroll: true,
      console: true,
    });
    const real = internals.collectorTeardowns.get("scroll")!;
    internals.collectorTeardowns.set("scroll", () => {
      real();
      throw new Error("half restored");
    });

    internals.applyRemoteConfig({ collectors: { scroll: false } });

    console.log("still here");
    expect(kinds("con")).toHaveLength(1);
    expect(internals.poisonedCollectors.has("console")).toBe(false);
    await logger.stop();
  });
});
