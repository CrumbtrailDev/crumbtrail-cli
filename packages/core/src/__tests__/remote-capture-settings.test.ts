// What a remote capture policy may and may not change about capture itself.
//
// Collector switches, network capture limits, the redaction policy and the
// plain throttles used to live only in the init block, so changing any of them
// meant shipping an SDK release. They now arrive on the capture-config poll.
//
// The poll answers from an endpoint the SDK does not authenticate, so the rule
// that matters here is direction: a policy may tighten what an application
// captures and may never loosen it. These tests pin each new applier, pin that
// an attempted loosening is a no-op, and pin the settings that stay local
// whatever a policy says.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import { DEFAULT_CONFIG, type CrumbtrailConfig } from "../types";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

/** Quiet collectors: these tests are about config values, not about capture. */
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
  configPollIntervalMs: 100_000,
  sessionPersistence: "memory",
} as const;

type Internals = {
  config: CrumbtrailConfig;
  remoteCollectorChanges: string[];
  applyRemoteConfig: (settings: Record<string, unknown>) => void;
};

function start(overrides: Record<string, unknown> = {}) {
  const transport = makeTransport();
  const logger = Crumbtrail.init({
    transportInstance: transport,
    ...QUIET,
    ...overrides,
  });
  return { logger, internals: logger as unknown as Internals };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote collector switches", () => {
  it("turns collectors on and off and reports which ones moved", async () => {
    const { logger, internals } = start({ console: true, campaign: false });

    internals.applyRemoteConfig({
      collectors: {
        console: false,
        campaign: true,
        network: false, // already false locally
      },
    });

    expect(internals.config.console).toBe(false);
    expect(internals.config.campaign).toBe(true);
    // Only the switches whose effective value changed are reported, which is
    // what phase 2 starts and stops mid-session.
    expect(internals.remoteCollectorChanges.sort()).toEqual([
      "campaign",
      "console",
    ]);
    await logger.stop();
  });

  it("covers every collector switch except media and the widget", async () => {
    const { logger, internals } = start({
      video: true,
      audio: true,
      widget: true,
    });

    internals.applyRemoteConfig({
      collectors: {
        console: true,
        network: true,
        interactions: true,
        keystrokes: true,
        scroll: true,
        visibility: true,
        clipboard: true,
        errors: true,
        performance: true,
        cookies: true,
        storage: true,
        heartbeat: true,
        uiNumbers: true,
        listeners: true,
        eventSource: true,
        webSocket: true,
        workers: true,
        environment: true,
        campaign: true,
        domSnapshot: true,
        video: false,
        audio: false,
        widget: false,
      },
    });

    expect(internals.remoteCollectorChanges).toHaveLength(20);
    expect(internals.remoteCollectorChanges).not.toContain("video");
    expect(internals.config.video).toBe(true);
    expect(internals.config.audio).toBe(true);
    expect(internals.config.widget).toBe(true);
    await logger.stop();
  });

  it("ignores unknown collector names and non-boolean values", async () => {
    const { logger, internals } = start({ console: true });

    internals.applyRemoteConfig({
      collectors: {
        console: "false",
        notACollector: true,
        httpEndpoint: "https://attacker.example",
      },
    });

    expect(internals.config.console).toBe(true);
    expect(internals.remoteCollectorChanges).toEqual([]);
    expect(
      (internals.config as unknown as Record<string, unknown>).notACollector,
    ).toBeUndefined();
    await logger.stop();
  });

  it("ignores collector switches placed at the top level of the policy", async () => {
    const { logger, internals } = start({ console: true });

    internals.applyRemoteConfig({ console: false, killSwitch: false });

    expect(internals.config.console).toBe(true);
    await logger.stop();
  });
});

describe("remote network limits", () => {
  it("lowers the captured body ceiling but never raises it", async () => {
    const { logger, internals } = start({ networkMaxBodySize: 1_000 });

    internals.applyRemoteConfig({ network: { maxBodySize: 400 } });
    expect(internals.config.networkMaxBodySize).toBe(400);

    // Above the local value, so the local value stands. Read against the
    // init-time floor, not the already-tightened live value, so successive
    // polls cannot ratchet the ceiling back up.
    internals.applyRemoteConfig({ network: { maxBodySize: 50_000 } });
    expect(internals.config.networkMaxBodySize).toBe(1_000);
    await logger.stop();
  });

  it("adds remote URL exclusions to the local ones and never drops a local one", async () => {
    const { logger, internals } = start({
      networkExcludeUrls: ["/local/secret"],
    });

    internals.applyRemoteConfig({
      network: { excludeUrls: ["/remote/health", "/local/secret"] },
    });
    expect(internals.config.networkExcludeUrls).toEqual([
      "/local/secret",
      "/remote/health",
    ]);

    internals.applyRemoteConfig({ network: { excludeUrls: [] } });
    expect(internals.config.networkExcludeUrls).toEqual(["/local/secret"]);
    await logger.stop();
  });

  it("refuses an exclusion list carrying a non-string entry", async () => {
    const { logger, internals } = start({ networkExcludeUrls: ["/local"] });

    internals.applyRemoteConfig({
      network: { excludeUrls: ["/remote", { url: "/sneaky" }] },
    });

    expect(internals.config.networkExcludeUrls).toEqual(["/local"]);
    await logger.stop();
  });

  it("turns header capture off but cannot turn it back on", async () => {
    const on = start({ networkCaptureHeaders: true });
    on.internals.applyRemoteConfig({ network: { captureHeaders: false } });
    expect(on.internals.config.networkCaptureHeaders).toBe(false);
    await on.logger.stop();

    const off = start({ networkCaptureHeaders: false });
    off.internals.applyRemoteConfig({ network: { captureHeaders: true } });
    expect(off.internals.config.networkCaptureHeaders).toBe(false);
    await off.logger.stop();
  });
});

describe("remote redaction policy", () => {
  it("adds deny fields to the local list and keeps every local entry", async () => {
    const { logger, internals } = start({
      redaction: { denyFields: ["localSecret"] },
    });

    internals.applyRemoteConfig({
      redaction: { denyFields: ["remoteSecret", "localSecret"] },
    });
    expect(internals.config.redaction?.denyFields).toEqual([
      "localSecret",
      "remoteSecret",
    ]);

    // An empty remote list cannot clear a local deny field.
    internals.applyRemoteConfig({ redaction: { denyFields: [] } });
    expect(internals.config.redaction?.denyFields).toEqual(["localSecret"]);
    await logger.stop();
  });

  it("moves structured redaction to full but never back", async () => {
    const structured = start({ redaction: { mode: "structured" } });
    structured.internals.applyRemoteConfig({ redaction: { mode: "full" } });
    expect(structured.internals.config.redaction?.mode).toBe("full");
    await structured.logger.stop();

    const full = start({ redaction: { mode: "full" } });
    full.internals.applyRemoteConfig({ redaction: { mode: "structured" } });
    expect(full.internals.config.redaction?.mode).toBe("full");
    await full.logger.stop();
  });

  it("can stop input values being captured but cannot start it", async () => {
    const off = start({ redaction: { captureInputValues: false } });
    off.internals.applyRemoteConfig({
      redaction: { captureInputValues: true },
    });
    expect(off.internals.config.redaction?.captureInputValues).toBe(false);
    await off.logger.stop();

    const on = start({ redaction: { captureInputValues: true } });
    on.internals.applyRemoteConfig({
      redaction: { captureInputValues: false },
    });
    expect(on.internals.config.redaction?.captureInputValues).toBe(false);
    await on.logger.stop();
  });

  it("ignores remote keep fields", async () => {
    const { logger, internals } = start({
      redaction: { denyFields: ["token"], keepFields: ["review"] },
    });

    internals.applyRemoteConfig({
      redaction: { keepFields: ["token", "password"] },
    });

    expect(internals.config.redaction?.keepFields).toEqual(["review"]);
    await logger.stop();
  });
});

describe("remote throttles and size limits", () => {
  it("sets each throttle outright", async () => {
    const { logger, internals } = start();

    internals.applyRemoteConfig({
      keystrokeThrottleMs: 250,
      scrollThrottleMs: 1_000,
      clipboardMaxLength: 100,
      cookieValueMaxLength: 120,
      storageValueMaxLength: 140,
      stateMaxBytes: 4_096,
      domSnapshotMaxBytes: 8_192,
      ringBufferMs: 120_000,
      ringBufferMaxEvents: 5_000,
    });

    expect(internals.config).toMatchObject({
      keystrokeThrottleMs: 250,
      scrollThrottleMs: 1_000,
      clipboardMaxLength: 100,
      cookieValueMaxLength: 120,
      storageValueMaxLength: 140,
      stateMaxBytes: 4_096,
      domSnapshotMaxBytes: 8_192,
      ringBufferMs: 120_000,
      ringBufferMaxEvents: 5_000,
    });
    await logger.stop();
  });

  it("refuses a throttle that is not a finite non-negative number", async () => {
    const { logger, internals } = start();

    internals.applyRemoteConfig({
      scrollThrottleMs: -1,
      clipboardMaxLength: "200",
      stateMaxBytes: Number.NaN,
    });

    expect(internals.config).toMatchObject({
      scrollThrottleMs: DEFAULT_CONFIG.scrollThrottleMs,
      clipboardMaxLength: DEFAULT_CONFIG.clipboardMaxLength,
      stateMaxBytes: DEFAULT_CONFIG.stateMaxBytes,
    });
    await logger.stop();
  });
});

describe("settings a remote policy can never set", () => {
  it("leaves the raw-capture opt-ins, masking and transport untouched", async () => {
    const { logger, internals } = start({
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_local",
      remoteConfig: false,
      configPollIntervalMs: 100_000,
    });
    const before = { ...internals.config };

    internals.applyRemoteConfig({
      captureRawConsole: true,
      captureRawErrors: true,
      captureRawClipboard: true,
      captureRawState: true,
      maskAllText: false,
      maskAllInputs: false,
      httpEndpoint: "https://attacker.example",
      httpAuthToken: "ctkey_attacker",
      transport: "http",
      configEndpoint: "https://attacker.example/config",
      remoteConfig: true,
      configPollIntervalMs: 10,
      collectors: {
        captureRawConsole: true,
        maskAllText: false,
      },
      redaction: { captureInputValues: true, keepFields: ["password"] },
      // A recognized field, so this is a real policy rather than a payload the
      // client would have ignored wholesale.
      killSwitch: false,
    });

    const neverRemote = [
      "captureRawConsole",
      "captureRawErrors",
      "captureRawClipboard",
      "captureRawState",
      "maskAllText",
      "maskAllInputs",
      "httpEndpoint",
      "httpAuthToken",
      "transport",
      "configEndpoint",
      "remoteConfig",
      "configPollIntervalMs",
    ] as const;
    for (const key of neverRemote)
      expect([key, internals.config[key]]).toEqual([key, before[key]]);
    expect(internals.config.maskAllText).toBe(true);
    expect(internals.config.maskAllInputs).toBe(true);
    await logger.stop();
  });
});

describe("policy recognition", () => {
  it("treats a response carrying only the new fields as a policy", async () => {
    const fetchStub = vi.fn().mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).includes("/api/capture-config")
          ? new Response(
              JSON.stringify({
                collectors: { console: false },
                network: { maxBodySize: 128 },
                keystrokeThrottleMs: 50,
              }),
            )
          : new Response('{"ok":true}'),
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    const { logger, internals } = start({
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    await vi.waitFor(() => {
      expect(
        (logger as unknown as { remotePolicyReady: boolean })
          .remotePolicyReady,
      ).toBe(true);
    });
    expect(internals.config.console).toBe(false);
    expect(internals.config.keystrokeThrottleMs).toBe(50);
    await logger.stop();
  });

  it("tolerates a schemaVersion without requiring one", async () => {
    const { logger, internals } = start();

    internals.applyRemoteConfig({
      schemaVersion: 2,
      collectors: { console: false },
    });
    expect(internals.config.console).toBe(false);

    // Nothing reads it, and it is not a policy field in its own right.
    expect(
      (internals.config as unknown as Record<string, unknown>).schemaVersion,
    ).toBeUndefined();
    await logger.stop();
  });
});
