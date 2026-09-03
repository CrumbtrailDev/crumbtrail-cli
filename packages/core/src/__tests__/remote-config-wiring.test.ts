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
import { Crumbtrail } from "../crumbtrail";
import type { RuntimeBindingClient } from "../runtime-binding";

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
  vi.restoreAllMocks();
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

  it("uses legacy untargeted polling for a config endpoint on another origin", async () => {
    const runtime = {
      instanceId: "ri_runtime_cross_origin",
      instanceProof: `proof_cross_origin_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        if (String(input).includes("/api/runtime/register"))
          return new Response(JSON.stringify(runtime), { status: 201 });
        return new Response(JSON.stringify({ killSwitch: false }), {
          status: 200,
        });
      },
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);

    const logger = Crumbtrail.init({
      ...QUIET,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      configEndpoint: "https://policy.example.test/api/capture-config",
      remoteConfig: true,
    });

    await vi.waitFor(() =>
      expect(
        calls.some((call) =>
          call.url.startsWith("https://policy.example.test/"),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call.url.endsWith("/api/session/start")),
      ).toBe(true),
    );
    const poll = calls.find((call) =>
      call.url.startsWith("https://policy.example.test/"),
    );
    const start = calls.find((call) => call.url.endsWith("/api/session/start"));
    const startBody = JSON.parse(String(start?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(startBody).toMatchObject({
      instanceId: runtime.instanceId,
      instanceProof: runtime.instanceProof,
    });
    expect(
      new URL(poll?.url ?? "https://invalid").searchParams.get("instanceId"),
    ).toBe(null);
    expect(poll?.init).not.toHaveProperty("headers");
    await logger.stop();
  });

  it("does not start a config request after polling is stopped during binding lookup", async () => {
    const fetch = stubFetch();
    const binding = deferred<{
      instanceId: string;
      instanceProof: string;
      expiresAt: string;
    }>();
    const runtimeBinding = {
      matchesOrigin: vi.fn(() => true),
      getBinding: vi.fn(() => binding.promise),
    } as unknown as RuntimeBindingClient;
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: false,
    });
    const stop = logger.startConfigPolling({
      endpoint: "https://api.crumbtrail.test/api/capture-config",
      projectKey: "ctkey_live",
      intervalMs: 100_000,
      runtimeBinding,
    });

    await vi.waitFor(() =>
      expect(runtimeBinding.getBinding).toHaveBeenCalled(),
    );
    stop();
    binding.resolve({
      instanceId: "ri_runtime_stopped",
      instanceProof: `proof_stopped_${"x".repeat(40)}`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      fetch.mock.calls.some((call) =>
        String(call[0]).includes("/api/capture-config"),
      ),
    ).toBe(false);
    await logger.stop();
  });

  it("polls without being asked, because the project settings page is the control", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
    });

    // No remoteConfig in this init. A team that switches session replay on in
    // the dashboard and changes nothing in their app must still get a replay.
    expect(pollUrl(fetch)?.pathname).toBe("/api/capture-config");
    await logger.stop();
  });

  it("does not poll, and does not wait for a policy, when remote config is turned off", async () => {
    const fetch = stubFetch();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: makeTransport(),
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: false,
    });

    expect(pollUrl(fetch)).toBeUndefined();
    // A client that opted out of a remote policy must not be held closed
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
