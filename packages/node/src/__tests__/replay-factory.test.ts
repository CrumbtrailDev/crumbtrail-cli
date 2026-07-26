import { describe, expect, it, vi } from "vitest";
import { buildReplayFlow } from "../replay/flow";
import {
  defaultReproducerFactory,
  runReproduction,
  type ReproducerFactory,
} from "../replay/factory";
import { NoopReproducer } from "../replay/noop";
import { PlaywrightReproducer } from "../replay/playwright";
import type { PlaywrightDriver } from "../replay/playwright";
import { parseReplayResult } from "../replay/result";
import type { ReplayFlow } from "../replay/types";

const TARGET = "http://localhost:4173";

const ALLOWED = {
  execute: true,
  allowlist: [{ origin: TARGET, isolated: true }],
};

/** A driver that resolves everything by exact selector and records nothing. */
function stubDriver(): PlaywrightDriver {
  const locator = {
    count: async () => 1,
    first: () => locator,
    click: async () => {},
    fill: async () => {},
  };
  const page = {
    goto: async () => undefined,
    locator: () => locator,
    getByRole: () => locator,
  };
  const context = { newPage: async () => page, close: async () => {} };
  return {
    chromium: {
      launch: async () => ({
        newContext: async () => context,
        close: async () => {},
      }),
    },
  };
}

const CHECKOUT_FLOW: ReplayFlow = buildReplayFlow({
  sourceSessionId: "ses_src_001",
  targetUrl: TARGET,
  events: [
    { k: "nav", d: { to: "https://shop.example.com/cart" } },
    {
      k: "clk",
      d: { el: { sig: "sig-go", path: "#checkout", tag: "BUTTON", txt: "Go" } },
    },
  ],
});

describe("defaultReproducerFactory", () => {
  it("yields the Playwright adapter for an execute decision", () => {
    const reproducer = defaultReproducerFactory({
      decision: { eligible: true, mode: "execute", targetOrigin: TARGET },
      policy: {
        execute: true,
        allowlist: [],
        maxSteps: 10,
        stepTimeoutMs: 100,
      },
    });

    expect(reproducer).toBeInstanceOf(PlaywrightReproducer);
    expect(reproducer.adapter).toBe("playwright");
  });

  it("yields the observation adapter for every observe decision", () => {
    const reproducer = defaultReproducerFactory({
      decision: {
        eligible: true,
        mode: "observe",
        refusal: { code: "execution_not_enabled", reason: "disabled." },
      },
      policy: {
        execute: false,
        allowlist: [],
        maxSteps: 10,
        stepTimeoutMs: 100,
      },
    });

    expect(reproducer).toBeInstanceOf(NoopReproducer);
    expect(reproducer.adapter).toBe("noop");
  });
});

describe("runReproduction — the seam is no longer inert", () => {
  it("observes by default: no policy, no opt-in, explained refusal", async () => {
    const outcome = await runReproduction({ flow: CHECKOUT_FLOW });

    expect(outcome.attempted).toBe(false);
    expect(outcome.adapter).toBe("noop");
    expect(outcome.mode).toBe("observe");
    expect(outcome.result).toBeUndefined();
    expect(outcome.refusal?.code).toBe("reproduction_not_requested");
    expect(outcome.note).toContain("without running them");
    expect(outcome.note).toContain("reproduction_not_requested");
  });

  it("still observes when the environment allows execution but the caller did not ask", async () => {
    const outcome = await runReproduction({
      flow: CHECKOUT_FLOW,
      policy: ALLOWED,
    });

    expect(outcome.adapter).toBe("noop");
    expect(outcome.refusal?.code).toBe("reproduction_not_requested");
  });

  it("still observes when the caller asks but the environment does not allow it", async () => {
    const outcome = await runReproduction({
      flow: CHECKOUT_FLOW,
      allowReproduction: true,
    });

    expect(outcome.adapter).toBe("noop");
    expect(outcome.refusal?.code).toBe("execution_not_enabled");
  });

  it("still observes when the target origin is not allowlisted", async () => {
    const outcome = await runReproduction({
      flow: { ...CHECKOUT_FLOW, targetUrl: "https://prod.example.com" },
      allowReproduction: true,
      policy: ALLOWED,
      loadDriver: async () => {
        throw new Error("must not be reached");
      },
    });

    expect(outcome.adapter).toBe("noop");
    expect(outcome.refusal?.code).toBe("target_not_allowlisted");
  });

  it("executes and emits replay-result.v1 when opt-in and allowlist agree", async () => {
    const loadDriver = vi.fn(async () => stubDriver());

    const outcome = await runReproduction({
      flow: CHECKOUT_FLOW,
      allowReproduction: true,
      policy: ALLOWED,
      loadDriver,
    });

    expect(loadDriver).toHaveBeenCalledOnce();
    expect(outcome.adapter).toBe("playwright");
    expect(outcome.attempted).toBe(true);
    expect(outcome.mode).toBe("execute");
    const result = parseReplayResult(
      JSON.parse(JSON.stringify(outcome.result)),
    );
    expect(result.sourceSessionId).toBe("ses_src_001");
    expect(result.steps).toHaveLength(2);
    expect(result.completed).toBe(true);
  });

  it("passes the policy step timeout through to the adapter", async () => {
    const timeouts: Array<number | undefined> = [];
    const loadDriver = async (): Promise<PlaywrightDriver> => {
      const locator = {
        count: async () => 1,
        first: () => locator,
        click: async (options?: { timeout?: number }) => {
          timeouts.push(options?.timeout);
        },
        fill: async () => {},
      };
      const page = {
        goto: async (_url: string, options?: { timeout?: number }) => {
          timeouts.push(options?.timeout);
          return undefined;
        },
        locator: () => locator,
        getByRole: () => locator,
      };
      const context = { newPage: async () => page, close: async () => {} };
      return {
        chromium: {
          launch: async () => ({
            newContext: async () => context,
            close: async () => {},
          }),
        },
      };
    };

    await runReproduction({
      flow: CHECKOUT_FLOW,
      allowReproduction: true,
      policy: { ...ALLOWED, stepTimeoutMs: 321 },
      loadDriver,
    });

    expect(timeouts).toEqual([321, 321]);
  });

  it("honours an injected reproducerFactory override", async () => {
    const factory = vi.fn<ReproducerFactory>(() => new NoopReproducer());

    const outcome = await runReproduction({
      flow: CHECKOUT_FLOW,
      allowReproduction: true,
      policy: ALLOWED,
      reproducerFactory: factory,
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0].decision.mode).toBe("execute");
    expect(factory.mock.calls[0][0].policy.stepTimeoutMs).toBe(5_000);
    expect(outcome.adapter).toBe("noop");
    // An override that returns the observation adapter for an execute decision
    // still explains itself rather than returning a bare no-op.
    expect(outcome.refusal?.code).toBe("execution_not_enabled");
  });

  it("refuses an ineligible flow without consulting a driver", async () => {
    const loadDriver = vi.fn(async () => stubDriver());

    const outcome = await runReproduction({
      flow: { ...CHECKOUT_FLOW, steps: [] },
      allowReproduction: true,
      policy: ALLOWED,
      loadDriver,
    });

    expect(loadDriver).not.toHaveBeenCalled();
    expect(outcome.refusal?.code).toBe("no_replayable_steps");
    expect(outcome.refusal?.remedy).toBeTruthy();
  });

  it("degrades to an explained refusal when Playwright is absent", async () => {
    const outcome = await runReproduction({
      flow: CHECKOUT_FLOW,
      allowReproduction: true,
      policy: ALLOWED,
      loadDriver: async () => {
        throw new Error("Cannot find package 'playwright'");
      },
    });

    expect(outcome.adapter).toBe("playwright");
    expect(outcome.attempted).toBe(false);
    expect(outcome.refusal?.code).toBe("driver_unavailable");
  });
});
