import { randomUUID } from "node:crypto";
import { flowCarriesSecret } from "./flow";
import { DEFAULT_REPLAY_STEP_TIMEOUT_MS } from "./policy";
import {
  buildReplayResult,
  type ReplayDivergence,
  type ReplayStepResult,
  type StepResolution,
} from "./result";
import type {
  ReplayDecision,
  ReplayFlow,
  ReplayRefusal,
  ReplayStep,
  Reproducer,
  ReproductionOutcome,
} from "./types";

/**
 * The actuating arm of the `Reproducer` seam: drives a captured flow through
 * Playwright and emits a `replay-result.v1` {@link ReplayResult}.
 *
 * ## Packaging
 *
 * `crumbtrail-node` is a published package, so Playwright must never become a
 * hard runtime dependency — installing it pulls browser binaries onto every
 * consumer. It is declared an **optional peer dependency** and loaded through
 * a dynamic import inside {@link loadPlaywrightDriver}, with a non-literal
 * specifier so neither `tsc` nor the bundler turns it into a static edge. When
 * it is absent the adapter degrades explicitly: a `driver_unavailable`
 * refusal, never a throw.
 *
 * ## Safety
 *
 * - It refuses any decision that is not `mode: "execute"`, so a hand-rolled
 *   factory cannot route around `policy.ts`.
 * - It re-checks the flow for credential-bearing steps before launching.
 * - It opens a **fresh** browser context with no arguments: no `storageState`,
 *   no `httpCredentials`, no `extraHTTPHeaders`. Nothing captured from the
 *   original session — cookies, tokens, storage — reaches the replayed page.
 * - Every navigation is rebased onto the allowlisted `flow.targetUrl`; the
 *   captured origin is never contacted.
 */

/* ── Minimal structural view of the Playwright API we depend on ───────────── */

export interface ReplayLocator {
  count(): Promise<number>;
  first(): ReplayLocator;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
}

export interface ReplayPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): ReplayLocator;
  getByRole(role: string, options?: { name?: string }): ReplayLocator;
}

export interface ReplayBrowserContext {
  newPage(): Promise<ReplayPage>;
  close(): Promise<void>;
}

export interface ReplayBrowser {
  newContext(): Promise<ReplayBrowserContext>;
  close(): Promise<void>;
}

export interface ReplayBrowserType {
  launch(options?: { headless?: boolean }): Promise<ReplayBrowser>;
}

export interface PlaywrightDriver {
  chromium: ReplayBrowserType;
}

/** Injection point for tests and for alternative drivers. */
export type PlaywrightLoader = () => Promise<PlaywrightDriver>;

/**
 * Loads the optional `playwright` peer. The specifier is held in a variable on
 * purpose: a bare `import("playwright")` would make the package a static type
 * and bundle dependency of a package most consumers install without it.
 */
export const loadPlaywrightDriver: PlaywrightLoader = async () => {
  const specifier = "playwright";
  const loaded = (await import(/* @vite-ignore */ specifier)) as unknown as
    | {
        chromium?: ReplayBrowserType;
        default?: { chromium?: ReplayBrowserType };
      }
    | undefined;
  const chromium = loaded?.chromium ?? loaded?.default?.chromium;
  if (!chromium) {
    throw new Error(
      "playwright resolved but did not export a chromium browser type",
    );
  }
  return { chromium };
};

export interface PlaywrightReproducerOptions {
  loadDriver?: PlaywrightLoader;
  stepTimeoutMs?: number;
  headless?: boolean;
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Injected for deterministic tests. */
  newActuatedSessionId?: () => string;
}

export class PlaywrightReproducer implements Reproducer {
  readonly adapter = "playwright" as const;

  private readonly loadDriver: PlaywrightLoader;
  private readonly stepTimeoutMs: number;
  private readonly headless: boolean;
  private readonly now: () => number;
  private readonly newActuatedSessionId: () => string;

  constructor(options: PlaywrightReproducerOptions = {}) {
    this.loadDriver = options.loadDriver ?? loadPlaywrightDriver;
    this.stepTimeoutMs =
      options.stepTimeoutMs ?? DEFAULT_REPLAY_STEP_TIMEOUT_MS;
    this.headless = options.headless ?? true;
    this.now = options.now ?? Date.now;
    this.newActuatedSessionId =
      options.newActuatedSessionId ??
      (() => `act_${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  }

  async reproduce(
    flow: ReplayFlow,
    decision: ReplayDecision,
  ): Promise<ReproductionOutcome> {
    if (decision.mode !== "execute") {
      return this.refuse(
        flow,
        decision.refusal ?? {
          code: "execution_not_enabled",
          reason:
            "The replay policy did not permit execution, so the Playwright adapter refused to run.",
        },
      );
    }

    const secretStep = flowCarriesSecret(flow);
    if (secretStep) {
      return this.refuse(flow, {
        code: "flow_carries_secret",
        reason: `Step ${secretStep.index} (${secretStep.sig}) depends on a credential-like value; captured secrets are never forwarded into a replay.`,
        remedy:
          "Replay a flow that reaches the failure without a credential, or seed the isolated environment with a fixture account.",
      });
    }

    let driver: PlaywrightDriver;
    try {
      driver = await this.loadDriver();
    } catch (error) {
      return this.refuse(flow, {
        code: "driver_unavailable",
        reason: `Playwright could not be loaded: ${messageOf(error)}`,
        remedy:
          "Install the optional peer with `pnpm add -D playwright` and `npx playwright install chromium`.",
      });
    }

    let browser: ReplayBrowser | undefined;
    let context: ReplayBrowserContext | undefined;
    try {
      browser = await driver.chromium.launch({ headless: this.headless });
      // No arguments on purpose: a fresh, empty context. No storageState, no
      // httpCredentials, no extraHTTPHeaders — nothing captured is replayed.
      context = await browser.newContext();
      const page = await context.newPage();
      return await this.drive(flow, page);
    } catch (error) {
      return this.refuse(flow, {
        code: "driver_unavailable",
        reason: `Playwright failed to start a browser: ${messageOf(error)}`,
        remedy: "Run `npx playwright install chromium` in this environment.",
      });
    } finally {
      await closeQuietly(context);
      await closeQuietly(browser);
    }
  }

  private async drive(
    flow: ReplayFlow,
    page: ReplayPage,
  ): Promise<ReproductionOutcome> {
    const steps: ReplayStepResult[] = [];
    const divergences: ReplayDivergence[] = [];
    let completed = true;

    for (const step of flow.steps) {
      const startedAt = this.now();
      let resolution: StepResolution = "failed";

      try {
        resolution = await this.runStep(flow, page, step, divergences);
      } catch (error) {
        divergences.push({
          index: step.index,
          sig: step.sig,
          reason: `${step.action} failed: ${messageOf(error)}`,
        });
      }

      steps.push({
        index: step.index,
        sig: step.sig,
        action: step.action,
        resolution,
        durationMs: Math.max(0, this.now() - startedAt),
      });

      // A failed navigation invalidates every later step; stop rather than
      // report resolutions measured against the wrong page.
      if (resolution === "failed" && step.action === "navigate") {
        completed = false;
        break;
      }
    }

    const result = buildReplayResult({
      sourceSessionId: flow.sourceSessionId,
      actuatedSessionId: this.newActuatedSessionId(),
      steps,
      divergences,
      completed,
    });

    return {
      attempted: true,
      mode: "execute",
      adapter: this.adapter,
      result,
      note: `Replayed ${steps.length}/${flow.steps.length} step(s) of ${flow.sourceSessionId} against ${flow.targetUrl}; ${divergences.length} divergence(s).`,
    };
  }

  private async runStep(
    flow: ReplayFlow,
    page: ReplayPage,
    step: ReplayStep,
    divergences: ReplayDivergence[],
  ): Promise<StepResolution> {
    if (step.action === "navigate") {
      const url = new URL(step.path ?? "/", flow.targetUrl).toString();
      await page.goto(url, { timeout: this.stepTimeoutMs });
      if (step.queryWithheld) {
        divergences.push({
          index: step.index,
          sig: step.sig,
          reason:
            "navigated without the captured query string: redaction removed a sensitive parameter",
        });
      }
      return "exact";
    }

    const resolved = await this.resolve(page, step);
    if (!resolved) {
      divergences.push({
        index: step.index,
        sig: step.sig,
        reason: `unresolvable: no exact, role-label, or structural match for ${describeTarget(step)}`,
      });
      return "failed";
    }

    if (step.action === "click") {
      await resolved.locator.click({ timeout: this.stepTimeoutMs });
      return resolved.resolution;
    }

    // input
    if (step.value?.kind === "literal") {
      await resolved.locator.fill(step.value.value, {
        timeout: this.stepTimeoutMs,
      });
      return resolved.resolution;
    }

    divergences.push({
      index: step.index,
      sig: step.sig,
      reason:
        step.value?.kind === "secret"
          ? `input skipped: ${step.value.reason}; captured secrets are never forwarded into a replay`
          : "input skipped: capture redacted the value, so there is nothing to type",
    });
    return resolved.resolution;
  }

  /**
   * The resolution ladder the `replay-result.v1` contract names: an exact
   * selector match, then role + accessible name, then a structural match.
   */
  private async resolve(
    page: ReplayPage,
    step: ReplayStep,
  ): Promise<
    { locator: ReplayLocator; resolution: StepResolution } | undefined
  > {
    if (step.selector) {
      const locator = page.locator(step.selector);
      const count = await locator.count();
      if (count === 1) return { locator, resolution: "exact" };
    }

    if (step.role && step.label) {
      const locator = page.getByRole(step.role, { name: step.label });
      if ((await locator.count()) >= 1)
        return { locator: locator.first(), resolution: "role-label" };
    }

    for (const selector of [step.selector, step.tag]) {
      if (!selector) continue;
      const locator = page.locator(selector);
      if ((await locator.count()) >= 1)
        return { locator: locator.first(), resolution: "structural" };
    }

    return undefined;
  }

  private refuse(
    flow: ReplayFlow,
    refusal: ReplayRefusal,
  ): ReproductionOutcome {
    return {
      attempted: false,
      mode: "observe",
      adapter: this.adapter,
      refusal,
      note: `Did not replay ${flow.sourceSessionId}: ${refusal.reason}`,
    };
  }
}

function describeTarget(step: ReplayStep): string {
  const parts = [
    step.role ?? step.tag ?? "element",
    step.label ? JSON.stringify(step.label) : undefined,
    step.selector ? `selector ${step.selector}` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeQuietly(
  closable: { close(): Promise<void> } | undefined,
): Promise<void> {
  if (!closable) return;
  try {
    await closable.close();
  } catch {
    // A teardown failure must not mask the replay outcome.
  }
}
