import { describe, expect, it, vi } from "vitest";
import { PlaywrightReproducer } from "../replay/playwright";
import type {
  PlaywrightDriver,
  ReplayBrowser,
  ReplayBrowserContext,
  ReplayLocator,
  ReplayPage,
} from "../replay/playwright";
import { parseReplayResult } from "../replay/result";
import type { ReplayDecision, ReplayFlow, ReplayStep } from "../replay/types";

const TARGET = "http://localhost:4173";

const EXECUTE: ReplayDecision = {
  eligible: true,
  mode: "execute",
  targetOrigin: TARGET,
};

/* ── Mocked Playwright driver ─────────────────────────────────────────────── */

interface MockElement {
  /** Selectors / role+name pairs this element answers to. */
  matches: string[];
  /** How many elements the query resolves to. */
  count?: number;
  clickError?: string;
  fillError?: string;
}

interface MockCalls {
  launch: Array<{ headless?: boolean } | undefined>;
  newContextArgs: unknown[][];
  goto: Array<{ url: string; timeout?: number }>;
  click: Array<{ key: string; timeout?: number }>;
  fill: Array<{ key: string; value: string; timeout?: number }>;
  queries: string[];
}

function mockDriver(options: {
  elements?: MockElement[];
  gotoError?: string;
  launchError?: string;
}): { driver: PlaywrightDriver; calls: MockCalls; closed: string[] } {
  const calls: MockCalls = {
    launch: [],
    newContextArgs: [],
    goto: [],
    click: [],
    fill: [],
    queries: [],
  };
  const closed: string[] = [];
  const elements = options.elements ?? [];

  const locatorFor = (key: string): ReplayLocator => {
    calls.queries.push(key);
    const element = elements.find((candidate) =>
      candidate.matches.includes(key),
    );
    const count = element ? (element.count ?? 1) : 0;
    const build = (): ReplayLocator => ({
      count: async () => count,
      first: () => build(),
      click: async (opts) => {
        if (element?.clickError) throw new Error(element.clickError);
        calls.click.push({ key, timeout: opts?.timeout });
      },
      fill: async (value, opts) => {
        if (element?.fillError) throw new Error(element.fillError);
        calls.fill.push({ key, value, timeout: opts?.timeout });
      },
    });
    return build();
  };

  const page: ReplayPage = {
    goto: async (url, opts) => {
      calls.goto.push({ url, timeout: opts?.timeout });
      if (options.gotoError) throw new Error(options.gotoError);
      return undefined;
    },
    locator: (selector) => locatorFor(selector),
    getByRole: (role, opts) => locatorFor(`role=${role}[name=${opts?.name}]`),
  };

  const context: ReplayBrowserContext = {
    newPage: async () => page,
    close: async () => {
      closed.push("context");
    },
  };

  const browser: ReplayBrowser = {
    newContext: async (...args: unknown[]) => {
      calls.newContextArgs.push(args);
      return context;
    },
    close: async () => {
      closed.push("browser");
    },
  };

  return {
    driver: {
      chromium: {
        launch: async (launchOptions) => {
          calls.launch.push(launchOptions);
          if (options.launchError) throw new Error(options.launchError);
          return browser;
        },
      },
    },
    calls,
    closed,
  };
}

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

function step(overrides: Partial<ReplayStep> & { index: number }): ReplayStep {
  return { sig: `sig-${overrides.index}`, action: "click", ...overrides };
}

function flow(
  steps: ReplayStep[],
  overrides: Partial<ReplayFlow> = {},
): ReplayFlow {
  return {
    sourceSessionId: "ses_src_001",
    targetUrl: TARGET,
    steps,
    ...overrides,
  };
}

function deterministicReproducer(
  driver: PlaywrightDriver,
  extra: { stepTimeoutMs?: number } = {},
) {
  let tick = 0;
  return new PlaywrightReproducer({
    loadDriver: async () => driver,
    stepTimeoutMs: extra.stepTimeoutMs ?? 1_500,
    now: () => (tick += 10),
    newActuatedSessionId: () => "act_fixed_001",
  });
}

/* ── Tests ────────────────────────────────────────────────────────────────── */

describe("PlaywrightReproducer — emits replay-result.v1", () => {
  it("walks the resolution ladder and produces a valid result", async () => {
    const { driver, calls } = mockDriver({
      elements: [
        { matches: ["#qty"] },
        { matches: ["role=button[name=Place order]"] },
        { matches: ["div"], count: 4 },
      ],
    });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([
        step({ index: 0, action: "navigate", sig: "nav:/cart", path: "/cart" }),
        step({
          index: 1,
          action: "input",
          selector: "#qty",
          tag: "input",
          value: { kind: "literal", value: "3" },
        }),
        step({
          index: 2,
          action: "click",
          selector: "#missing",
          role: "button",
          label: "Place order",
          tag: "button",
        }),
        step({ index: 3, action: "click", tag: "div" }),
        step({ index: 4, action: "click", selector: "#gone", tag: "aside" }),
      ]),
      EXECUTE,
    );

    expect(outcome.attempted).toBe(true);
    expect(outcome.adapter).toBe("playwright");
    expect(outcome.mode).toBe("execute");
    expect(outcome.refusal).toBeUndefined();

    // The emitted payload satisfies the shipped contract parser.
    const result = parseReplayResult(
      JSON.parse(JSON.stringify(outcome.result)),
    );
    expect(result.schemaVersion).toBe("replay-result.v1");
    expect(result.sourceSessionId).toBe("ses_src_001");
    expect(result.actuatedSessionId).toBe("act_fixed_001");
    expect(result.completed).toBe(true);
    expect(result.steps.map((entry) => entry.resolution)).toEqual([
      "exact",
      "exact",
      "role-label",
      "structural",
      "failed",
    ]);
    expect(result.steps.every((entry) => entry.durationMs >= 0)).toBe(true);
    expect(result.divergences).toEqual([
      {
        index: 4,
        sig: "sig-4",
        reason:
          "unresolvable: no exact, role-label, or structural match for aside selector #gone",
      },
    ]);

    expect(calls.goto).toEqual([
      { url: "http://localhost:4173/cart", timeout: 1_500 },
    ]);
    expect(calls.fill).toEqual([{ key: "#qty", value: "3", timeout: 1_500 }]);
  });

  it("treats an ambiguous exact selector as a structural match", async () => {
    const { driver } = mockDriver({
      elements: [{ matches: [".row-action"], count: 3 }],
    });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: ".row-action" })]),
      EXECUTE,
    );

    expect(outcome.result?.steps[0].resolution).toBe("structural");
  });

  it("records a divergence when a resolved action throws", async () => {
    const { driver } = mockDriver({
      elements: [{ matches: ["#go"], clickError: "element is not visible" }],
    });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      EXECUTE,
    );

    expect(outcome.result?.steps[0].resolution).toBe("failed");
    expect(outcome.result?.divergences[0].reason).toContain(
      "click failed: element is not visible",
    );
    expect(outcome.result?.completed).toBe(true);
  });

  it("stops after a failed navigation and reports completed: false", async () => {
    const { driver, calls } = mockDriver({
      gotoError: "net::ERR_CONNECTION_REFUSED",
      elements: [{ matches: ["#go"] }],
    });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([
        step({ index: 0, action: "navigate", sig: "nav:/", path: "/" }),
        step({ index: 1, action: "click", selector: "#go" }),
      ]),
      EXECUTE,
    );

    expect(outcome.result?.completed).toBe(false);
    expect(outcome.result?.steps).toHaveLength(1);
    expect(outcome.result?.divergences[0].reason).toContain(
      "ERR_CONNECTION_REFUSED",
    );
    expect(calls.click).toEqual([]);
  });

  it("notes a navigation whose query string redaction removed", async () => {
    const { driver } = mockDriver({});

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([
        step({
          index: 0,
          action: "navigate",
          sig: "nav:/cb",
          path: "/cb",
          queryWithheld: true,
        }),
      ]),
      EXECUTE,
    );

    expect(outcome.result?.steps[0].resolution).toBe("exact");
    expect(outcome.result?.divergences[0].reason).toContain(
      "redaction removed a sensitive parameter",
    );
  });
});

describe("PlaywrightReproducer — safety", () => {
  it("never sends a captured credential into the page", async () => {
    const { driver, calls } = mockDriver({ elements: [{ matches: ["#pw"] }] });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([
        step({
          index: 0,
          action: "input",
          selector: "#pw",
          value: { kind: "redacted" },
        }),
      ]),
      EXECUTE,
    );

    expect(calls.fill).toEqual([]);
    expect(outcome.result?.steps[0].resolution).toBe("exact");
    expect(outcome.result?.divergences[0].reason).toContain(
      "capture redacted the value",
    );
  });

  it("refuses the whole flow when a step is marked secret, before launching", async () => {
    const { driver, calls } = mockDriver({});

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([
        step({
          index: 0,
          action: "input",
          selector: "#pw",
          value: { kind: "secret", reason: "field is credential-like" },
        }),
      ]),
      EXECUTE,
    );

    expect(outcome.attempted).toBe(false);
    expect(outcome.refusal?.code).toBe("flow_carries_secret");
    expect(calls.launch).toEqual([]);
  });

  it("opens a fresh context with no captured storage, credentials or headers", async () => {
    const { driver, calls } = mockDriver({ elements: [{ matches: ["#go"] }] });

    await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      EXECUTE,
    );

    expect(calls.newContextArgs).toEqual([[]]);
    expect(calls.launch).toEqual([{ headless: true }]);
  });

  it("refuses a decision that is not execute even if it is handed one", async () => {
    const { driver, calls } = mockDriver({});

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      {
        eligible: true,
        mode: "observe",
        refusal: {
          code: "target_not_allowlisted",
          reason: "Origin is not on the replay execution allowlist.",
        },
      },
    );

    expect(outcome.attempted).toBe(false);
    expect(outcome.mode).toBe("observe");
    expect(outcome.refusal?.code).toBe("target_not_allowlisted");
    expect(calls.launch).toEqual([]);
  });

  it("supplies a refusal even when an observe decision carries none", async () => {
    const { driver } = mockDriver({});

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0 })]),
      { eligible: true, mode: "observe" },
    );

    expect(outcome.refusal?.code).toBe("execution_not_enabled");
    expect(outcome.note).toContain("Did not replay ses_src_001");
  });

  it("closes the context and the browser even when a step throws", async () => {
    const { driver, closed } = mockDriver({
      elements: [{ matches: ["#go"], clickError: "boom" }],
    });

    await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      EXECUTE,
    );

    expect(closed).toEqual(["context", "browser"]);
  });
});

describe("PlaywrightReproducer — degrades explicitly without Playwright", () => {
  it("reports driver_unavailable when the import fails", async () => {
    const loadDriver = vi.fn(async () => {
      const error = new Error("Cannot find package 'playwright'");
      (error as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    const outcome = await new PlaywrightReproducer({ loadDriver }).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      EXECUTE,
    );

    expect(loadDriver).toHaveBeenCalledOnce();
    expect(outcome.attempted).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(outcome.refusal?.code).toBe("driver_unavailable");
    expect(outcome.refusal?.reason).toContain(
      "Cannot find package 'playwright'",
    );
    expect(outcome.refusal?.remedy).toContain("playwright install chromium");
  });

  it("reports driver_unavailable when the browser binary will not launch", async () => {
    const { driver } = mockDriver({
      launchError: "Executable doesn't exist at .../chromium",
    });

    const outcome = await deterministicReproducer(driver).reproduce(
      flow([step({ index: 0, action: "click", selector: "#go" })]),
      EXECUTE,
    );

    expect(outcome.attempted).toBe(false);
    expect(outcome.refusal?.code).toBe("driver_unavailable");
    expect(outcome.refusal?.reason).toContain("failed to start a browser");
  });

  it("does not throw — an absent driver is a refusal, not a crash", async () => {
    const outcome = await new PlaywrightReproducer({
      loadDriver: async () => {
        throw new Error("nope");
      },
    }).reproduce(flow([step({ index: 0 })]), EXECUTE);

    expect(outcome.refusal?.code).toBe("driver_unavailable");
  });
});
