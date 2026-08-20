// What decides whether a project's capture settings ever reach a running app.
//
// The settings page in the dashboard writes the kill switch, the auto flag
// triggers and their tail, baseline sampling, consent mode, client side masking,
// session replay and live probes. Every one of those reaches the browser SDK on
// the capture config poll and on no other path, so a client that does not poll
// renders that whole screen decorative: it saves, it persists, it displays as
// applied, and nothing in the app changes.
//
// These tests pin the two halves of the switch that turns the poll on, and the
// fact that a client only has to be told to poll — never told where, and never
// handed a second copy of the key it already carries.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../bug-logger";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

/** Quiet collectors: this file is about one fetch, not about capture. */
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
} as const;

function stubFetch() {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        killSwitch: false,
        maskingMode: "mask_all",
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The config poll, if one was made. */
function pollUrl(fetch: ReturnType<typeof stubFetch>): URL | undefined {
  const call = fetch.mock.calls.find((args) =>
    String(args[0]).includes("/api/capture-config"),
  );
  return call
    ? new URL(String(call[0]), "http://app.example.test/")
    : undefined;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote capture config wiring", () => {
  it("polls the config route on the ingest host, authenticated with the ingest key it already has", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    const url = pollUrl(fetch);
    expect(url?.origin).toBe("https://api.crumbtrail.test");
    expect(url?.pathname).toBe("/api/capture-config");
    // Not a second field the caller has to keep in step with httpAuthToken.
    expect(url?.searchParams.get("projectKey")).toBe("ctkey_live");
    await logger.stop();
  });

  it("tolerates a trailing slash on the ingest host rather than doubling it", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test/",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    expect(pollUrl(fetch)?.pathname).toBe("/api/capture-config");
    await logger.stop();
  });

  it("sends the poll to an explicit configEndpoint when a self hosted config service is named", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      configEndpoint: "https://policy.example.test/api/capture-config",
      remoteConfig: true,
    });

    expect(pollUrl(fetch)?.origin).toBe("https://policy.example.test");
    await logger.stop();
  });

  it("does not poll, and does not wait for a policy, when remote config is off", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
    });

    expect(pollUrl(fetch)).toBeUndefined();
    // A client that never asked for a remote policy must not be held closed
    // waiting for one that can never arrive.
    expect(
      (logger as unknown as { remotePolicyReady: boolean }).remotePolicyReady,
    ).toBe(true);
    await logger.stop();
  });

  it("stays unblocked instead of waiting forever when remote config is on but no ingest key is set", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      remoteConfig: true,
    });

    expect(pollUrl(fetch)).toBeUndefined();
    expect(
      (logger as unknown as { remotePolicyReady: boolean }).remotePolicyReady,
    ).toBe(true);
    await logger.stop();
  });
});
