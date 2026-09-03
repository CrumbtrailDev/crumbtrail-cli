import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProbeContext, ProbeName } from "../probes";
import type { BugEvent, CrumbtrailConfig } from "../types";

/**
 * Every call the config poll makes into the probe registry, with the context runProbe was handed
 * and the signal each context supplier was called with. Recorded by wrapping the real `runProbe`
 * rather than replacing it, so these tests exercise the shipped probe implementations.
 */
interface RecordedProbeCall {
  name: string;
  ctx: ProbeContext;
}

const probeCalls: RecordedProbeCall[] = [];
const stateSupplierCalls: Array<{ name: string; signal: AbortSignal }> = [];

/**
 * Runs synchronously as each probe is dispatched, before the loop awaits it. This is the only
 * seam that can act *between* two probes of one run, which is what the mid-run interruption
 * tests need: everything a caller can do from the outside lands after the whole run.
 */
let onProbeDispatch: ((name: string, index: number) => void) | undefined;

vi.mock("../probes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../probes")>();
  return {
    ...actual,
    runProbe: (name: string, ctx: ProbeContext = {}) => {
      probeCalls.push({ name, ctx });
      onProbeDispatch?.(name, probeCalls.length - 1);
      // Wrap `getState` so the signal runProbe threads into the host's supplier is observable.
      // This is the only way to prove the deadline signal reaches the SDK's own suppliers rather
      // than stopping at the registry boundary.
      const observed: ProbeContext = {
        ...ctx,
        getState: ctx.getState
          ? (stateName: string, signal: AbortSignal) => {
              stateSupplierCalls.push({ name: stateName, signal });
              return ctx.getState?.(stateName, signal);
            }
          : undefined,
      };
      return actual.runProbe(name, observed);
    },
  };
});

// Imported after vi.mock so the logger binds to the wrapped registry.
const { Crumbtrail } = await import("../crumbtrail");
const { PROBE_RESULT_EVENT_KIND } = await import("../crumbtrail");
const { PROBE_NAMES } = await import("../probes");

/** Collectors off: this suite asserts on exact event counts, so nothing else may emit. */
const COLLECTORS_OFF: Partial<CrumbtrailConfig> = {
  console: false,
  network: false,
  interactions: false,
  keystrokes: false,
  scroll: false,
  visibility: false,
  clipboard: false,
  cookies: false,
  storage: false,
  errors: false,
  performance: false,
  heartbeat: false,
  uiNumbers: false,
  listeners: false,
  eventSource: false,
  webSocket: false,
  workers: false,
  widget: false,
};

function makeTransport() {
  const sent: BugEvent[] = [];
  return {
    sent,
    sendEvents: vi.fn(async (events: BugEvent[]) => {
      sent.push(...events);
    }),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

type Transport = ReturnType<typeof makeTransport>;

/**
 * A real policy field, mixed into every payload below that is not deliberately testing its
 * absence. A response carrying nothing but `probes` is not a policy envelope: it cannot set
 * `remotePolicyReady`, so it cannot unblock the capture its own results would ride on, and the
 * probe request it carries is dropped with it.
 */
const POLICY = { captureSampleRate: 1 };

/** Start polling against a payload that already carries a policy field. */
function startWithPollPayload(
  payload: Record<string, unknown>,
  extra: Partial<CrumbtrailConfig> = {},
): { logger: ReturnType<typeof Crumbtrail.init>; transport: Transport } {
  return startWithRawPollPayload({ ...POLICY, ...payload }, extra);
}

/** Start polling against exactly the payload given, policy field or not. */
function startWithRawPollPayload(
  payload: unknown,
  extra: Partial<CrumbtrailConfig> = {},
): { logger: ReturnType<typeof Crumbtrail.init>; transport: Transport } {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))),
  );
  const transport = makeTransport();
  const logger = Crumbtrail.init({
    ...COLLECTORS_OFF,
    ...extra,
    transportInstance: transport,
    configEndpoint: "/api/capture-config",
    httpAuthToken: "ctkey_test",
    remoteConfig: true,
    configPollIntervalMs: 100_000,
    flushIntervalMs: 100_000,
    // Flush on every emit so an assertion never races the batch interval.
    flushBufferSize: 1,
  });
  return { logger, transport };
}

const POLL_OPTIONS = {
  endpoint: "/api/capture-config",
  projectKey: "ctkey_test",
};

/**
 * Start polling by hand, so the test holds the disposer `startConfigPolling` returns and can serve
 * a different payload to each poll. `Crumbtrail.init` is given no `configEndpoint`, so this is the
 * only polling loop running.
 */
function startManualPolling(
  payloads: Record<string, unknown>[],
  intervalMs = 100_000,
): {
  logger: ReturnType<typeof Crumbtrail.init>;
  transport: Transport;
  stop: () => void;
  restart: () => () => void;
} {
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return Promise.resolve(new Response(JSON.stringify(payload)));
    }),
  );
  const transport = makeTransport();
  const logger = Crumbtrail.init({
    ...COLLECTORS_OFF,
    transportInstance: transport,
    flushIntervalMs: 100_000,
    flushBufferSize: 1,
  });
  const stop = logger.startConfigPolling({ ...POLL_OPTIONS, intervalMs });
  return {
    logger,
    transport,
    stop,
    restart: () => logger.startConfigPolling({ ...POLL_OPTIONS, intervalMs }),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let the poll's fetch, its json(), and the awaited probe run all settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function probeResults(transport: Transport): BugEvent[] {
  return transport.sent.filter(
    (event) => event.k === PROBE_RESULT_EVENT_KIND,
  );
}

beforeEach(() => {
  probeCalls.length = 0;
  stateSupplierCalls.length = 0;
  onProbeDispatch = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probe dispatch from the config poll", () => {
  it("runs one probe and emits one result, dropping the names that are not on the allowlist", async () => {
    const { logger, transport } = startWithPollPayload({
      probes: ["storage.snapshot", "evil.exec", "../../etc/passwd"],
    });
    await settle();

    expect(probeCalls.map((call) => call.name)).toEqual(["storage.snapshot"]);

    const results = probeResults(transport);
    expect(results).toHaveLength(1);
    expect(results[0].d.name).toBe("storage.snapshot");
    expect(results[0].d.ok).toBe(true);
    expect(Array.isArray(results[0].d.rows)).toBe(true);

    await logger.stop();
  });

  it("polls with no-store, so a cached body cannot replay a probe request", async () => {
    // The config route answers `Cache-Control: private, max-age=60` and the default poll interval
    // is exactly that. A cache hit would re-run the probe the cached body asked for and rest a
    // second copy of the answer out of a live application, with nothing server side recording it.
    const { logger } = startWithPollPayload({ probes: ["storage.snapshot"] });
    await settle();

    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect((call[1] as RequestInit).cache).toBe("no-store");

    await logger.stop();
  });

  it("caps a poll at four probes and runs each name once", async () => {
    // The allowlist has five names while delivery remains capped at four. This assertion is the
    // tripwire that keeps a fifth name from silently widening one poll's execution budget.
    expect(PROBE_NAMES).toHaveLength(5);

    const { logger, transport } = startWithPollPayload({
      probes: [
        ...PROBE_NAMES,
        ...PROBE_NAMES,
        "storage.snapshot",
        "not.a.probe",
        "runtime.env ",
        "RUNTIME.ENV",
      ],
    });
    await settle();

    expect(probeCalls).toHaveLength(4);
    expect(probeCalls.map((call) => call.name).sort()).toEqual(
      [...PROBE_NAMES.slice(0, 4)].sort(),
    );
    expect(probeResults(transport)).toHaveLength(4);

    await logger.stop();
  });

  it("refuses a probes list long enough to be a denial of service rather than a request", async () => {
    const { logger, transport } = startWithPollPayload({
      probes: Array.from({ length: 65 }, () => "storage.snapshot"),
    });
    await settle();

    expect(probeCalls).toHaveLength(0);
    expect(probeResults(transport)).toHaveLength(0);

    await logger.stop();
  });

  it("reports network.inflight as unavailable rather than as an empty table", async () => {
    const { logger, transport } = startWithPollPayload({
      probes: ["network.inflight"],
    });
    await settle();

    const results = probeResults(transport);
    expect(results).toHaveLength(1);
    expect(results[0].d.ok).toBe(false);
    expect(results[0].d.error).toBe("unavailable");
    expect(results[0].d.rows).toEqual([]);

    await logger.stop();
  });

  it("answers network.inflight from the collector's registered live state", async () => {
    const { logger, transport } = startWithPollPayload({
      probes: ["network.inflight"],
    });
    logger.registerStateProvider("network.pending", () => [
      { method: "GET", url: "https://api.example.com/orders?token=abc", ageMs: 1200 },
    ]);
    await settle();

    const results = probeResults(transport);
    expect(results).toHaveLength(1);
    expect(results[0].d.ok).toBe(true);
    expect(results[0].d.rows).toHaveLength(1);

    await logger.stop();
  });

  it("does not run a probe once the kill switch is set", async () => {
    const { logger, transport } = startWithPollPayload({
      killSwitch: true,
      probes: ["storage.snapshot"],
    });
    await settle();

    expect(probeCalls).toHaveLength(0);
    expect(probeResults(transport)).toHaveLength(0);

    await logger.stop();
  });
});

describe("probe dispatch deadline signal", () => {
  it("hands the SDK's own state supplier the probe's live deadline signal", async () => {
    const { logger } = startWithPollPayload({ probes: ["network.inflight"] });
    logger.registerStateProvider("network.pending", () => []);
    await settle();

    expect(stateSupplierCalls).toHaveLength(1);
    const { name, signal } = stateSupplierCalls[0];
    expect(name).toBe("network.pending");
    expect(signal).toBeInstanceOf(AbortSignal);
    // Not aborted while the probe is still inside its deadline: this is a live signal, not a
    // placeholder handed over to satisfy a signature.
    expect(signal.aborted).toBe(false);

    await logger.stop();
  });

  it("refuses to read host state through an already aborted signal", async () => {
    const { logger } = startWithPollPayload({ probes: ["network.inflight"] });
    const provider = vi.fn(() => []);
    logger.registerStateProvider("network.pending", provider);
    await settle();

    expect(provider).toHaveBeenCalledTimes(1);

    // The context the logger builds is the object under test: replay it with an aborted signal
    // and the host application is not touched again.
    const ctx = probeCalls[0].ctx;
    const aborted = AbortSignal.abort();
    expect(ctx.getState?.("network.pending", aborted)).toBeUndefined();
    expect(ctx.getDeclaredEnv?.(aborted)).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);

    await logger.stop();
  });
});

describe("probe dispatch rejects a parameterised probe request", () => {
  it("rejects the whole probes field when one entry is an object", async () => {
    const { logger, transport } = startWithPollPayload({
      probes: [
        "storage.snapshot",
        {
          name: "runtime.env",
          selector: "#checkout input[name=card]",
          url: "https://attacker.example/exfil",
          path: "../../etc/passwd",
          expression: "fetch('https://attacker.example')",
        },
      ],
    });
    await settle();

    expect(probeCalls).toHaveLength(0);
    expect(probeResults(transport)).toHaveLength(0);

    await logger.stop();
  });

  it("never echoes injected content back into a captured event", async () => {
    const injected = "rm -rf /";
    // A payload that does get applied — one real probe runs — while every other field it carries
    // is attacker chosen. The event that rests must be the probe's own answer and nothing else.
    const { logger, transport } = startWithPollPayload({
      probes: [
        "storage.snapshot",
        `storage.snapshot; ${injected}`,
        `${injected}`,
      ],
      reason: injected,
      note: injected,
      raise: ["network", injected],
      signature: injected,
    });
    await settle();

    expect(probeCalls.map((call) => call.name)).toEqual(["storage.snapshot"]);
    expect(probeResults(transport)).toHaveLength(1);
    expect(JSON.stringify(transport.sent)).not.toContain(injected);
    expect(JSON.stringify(transport.sent)).not.toContain("rm");

    await logger.stop();
  });

  it("runs nothing for a poll that carries a probe request and no policy at all", async () => {
    // The ordering guarantee is that a probe runs only once the remote policy is live. A
    // probes-only response must therefore not count as that policy, or the probe request becomes
    // the thing that grants its own results the readiness they need to be captured.
    const { logger, transport } = startWithRawPollPayload({
      probes: ["storage.snapshot"],
    });
    await settle();

    expect(probeCalls).toHaveLength(0);
    expect(probeResults(transport)).toHaveLength(0);
    // Nothing at all was unblocked: with no policy recognized, capture never opened.
    expect(transport.startSession).not.toHaveBeenCalled();

    await logger.stop();
  });

  it("never passes a payload value into a probe as an argument", async () => {
    const { logger } = startWithPollPayload({
      probes: ["runtime.env"],
      probeArgs: { selector: "#secret" },
      timeoutMs: 999_999,
      maxRows: 10_000_000,
    });
    await settle();

    expect(probeCalls).toHaveLength(1);
    const ctx = probeCalls[0].ctx;
    // The context is built from this instance's own state. Nothing a response body carries —
    // not a selector, not a bound, not a clock — reaches it.
    expect(ctx.timeoutMs).toBeUndefined();
    expect(ctx.maxRows).toBeUndefined();
    expect(ctx.maxBytes).toBeUndefined();
    expect(Object.keys(ctx).sort()).toEqual(["getDeclaredEnv", "getState"]);

    await logger.stop();
  });
});

describe("probe dispatch ordering against the remote policy", () => {
  it("runs a probe only after the polled policy has been applied", async () => {
    const startSessionsAtDispatch: number[] = [];
    const { logger, transport } = startWithPollPayload({
      probes: ["storage.snapshot"],
    });
    // `startSession` is called synchronously from `applyRemoteConfig`, so its call count read at
    // the moment a probe is dispatched says whether the policy went live first. Ordering is the
    // whole invariant here: a probe that ran before the policy would see a zero.
    onProbeDispatch = () => {
      startSessionsAtDispatch.push(transport.startSession.mock.calls.length);
    };
    await settle();

    expect(probeCalls).toHaveLength(1);
    expect(startSessionsAtDispatch).toEqual([1]);
    // And the result was admitted, which needs the policy live at emit time too.
    expect(probeResults(transport)).toHaveLength(1);

    await logger.stop();
  });

  it("does not read the visitor's storage while consent is required and not granted", async () => {
    // `consentMode: "required"` with no `consent(true)` means capture is not allowed. Reading
    // localStorage and dropping the result at the bus is not the same as never reading it.
    const { logger, transport } = startWithPollPayload({
      consentMode: "required",
      probes: ["storage.snapshot"],
    });
    await settle();

    expect(probeCalls).toHaveLength(0);
    expect(probeResults(transport)).toHaveLength(0);

    await logger.stop();
  });

  it("runs the probe once the same visitor grants consent on a later poll", async () => {
    // The consent gate is a gate, not a refusal: proof that the test above fails for the stated
    // reason and not because a `consentMode` payload never dispatches a probe at all.
    const { logger, transport, restart } = startManualPolling([
      { ...POLICY, consentMode: "required", probes: ["storage.snapshot"] },
    ]);
    await settle();
    expect(probeCalls).toHaveLength(0);

    logger.consent(true);
    restart();
    await settle();

    expect(probeCalls.map((call) => call.name)).toContain("storage.snapshot");
    expect(probeResults(transport).length).toBeGreaterThan(0);

    await logger.stop();
  });
});

describe("probe dispatch interruption mid run", () => {
  it("halts a run already in flight when the caller stops polling", async () => {
    let stop: (() => void) | undefined;
    // Runs between the first probe and the second, which is the only window where a stop can be
    // the thing that halts the run rather than arriving after it finished anyway.
    onProbeDispatch = (_name, index) => {
      if (index === 0) stop?.();
    };
    const started = startManualPolling([
      { ...POLICY, probes: [...PROBE_NAMES] },
    ]);
    stop = started.stop;
    await settle();

    expect(probeCalls).toHaveLength(1);
    // The first probe's own result is dropped too: the host asked for polling to end before it
    // came back.
    expect(probeResults(started.transport)).toHaveLength(0);

    await started.logger.stop();
  });

  it("abandons a run in flight once a newer poll generation begins", async () => {
    // The first probe is held open for 1200ms by the state provider it reads, while the poll
    // interval is at its 1000ms floor. So the next scheduled poll starts, and increments the
    // generation, while this run is still inside its first probe. Nothing else changes: an
    // interval poll leaves consent, the kill switch and policy readiness exactly as they were, so
    // the generation is the only thing that can end the run.
    const { logger, transport } = startManualPolling(
      [
        {
          ...POLICY,
          probes: ["network.inflight", "storage.snapshot", "runtime.env"],
        },
        POLICY,
      ],
      1000,
    );
    let held = false;
    logger.registerStateProvider(
      "network.pending",
      () =>
        new Promise((resolve) => {
          held = true;
          setTimeout(() => resolve([]), 1200);
        }) as unknown as unknown[],
    );
    await delay(2400);
    await settle();

    expect(held).toBe(true);
    // Only the first probe ever ran, and its answer never rested: the run belonged to a poll that
    // has been superseded.
    expect(probeCalls.map((call) => call.name)).toEqual(["network.inflight"]);
    expect(probeResults(transport)).toHaveLength(0);

    await logger.stop();
  });
});
