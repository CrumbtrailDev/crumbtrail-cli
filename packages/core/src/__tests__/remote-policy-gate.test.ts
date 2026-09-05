// What happens to capture between init() and the first answer from the capture
// config route.
//
// `remoteConfig: true` is what the CLI installer writes into every generated
// init block, so this window is the standard configuration, not an edge case.
// Until the poll answers, `canTransport()` is false and the bus admission
// predicate refuses every event. Two things must survive that window:
//
//   - the `crumbtrail-core/early` queue, which is one-shot: drained into a
//     refusing bus it is gone, and the first-screen requests whose correlation
//     headers the backend already recorded are orphaned with no `capture_gap`
//     to say so.
//   - the session itself, when the answer never comes. A blocked, offline or
//     policy-less config route must not mean a session that silently captures
//     nothing forever.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail, REMOTE_POLICY_TIMEOUT_MS } from "../crumbtrail";
import {
  installEarlyCapture,
  uninstallEarlyCapture,
} from "../early-capture";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "../types";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

/** Everything off but the network collector: this file is about admission. */
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

function delivered(transport: ReturnType<typeof makeTransport>): BugEvent[] {
  return transport.sendEvents.mock.calls.flatMap(
    (call) => call[0] as BugEvent[],
  );
}

function appResponse(): Response {
  return new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const RECOGNIZED_POLICY = JSON.stringify({
  killSwitch: false,
  maskingMode: "mask_all",
});

describe("the window between init() and the first capture policy", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sessionStorage.clear();
  });

  afterEach(() => {
    uninstallEarlyCapture();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the early queue until the policy arrives, then replays it", async () => {
    let answerConfig: (() => void) | undefined;
    const configAnswer = new Promise<Response>((resolve) => {
      answerConfig = () => resolve(new Response(RECOGNIZED_POLICY));
    });
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config")) return configAnswer;
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    installEarlyCapture();
    await globalThis.fetch("/api/orders");

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      network: true,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    answerConfig?.();
    await configAnswer;
    // Let the poll's `await response.json()` and its continuation run.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await logger.stop();

    const early = delivered(transport).filter(
      (event) => event.k === "net.req" && event.d?.early === true,
    );
    expect(early).toHaveLength(1);
    expect(String(early[0]?.d?.url)).toContain("/api/orders");
  });


  // The dogfood shape: an application that imports `crumbtrail-core/early`,
  // initializes with `remoteConfig: true`, and loads its first screen while the
  // capture policy is still in flight. Three of the four requests came back as
  // `net.res` with no `net.req` and one vanished entirely, because the request
  // half was emitted into a bus that was still refusing events and the response
  // half arrived after the policy opened it. A half recorded request is worse
  // than none: the reader sees a response with no call behind it.
  it("records both halves of every request issued while the policy is in flight", async () => {
    let answerConfig: (() => void) | undefined;
    const configAnswer = new Promise<Response>((resolve) => {
      answerConfig = () => resolve(new Response(RECOGNIZED_POLICY));
    });
    const pending = new Map<string, (response: Response) => void>();
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("/api/capture-config")) return configAnswer;
      if (url.includes("/held/"))
        return new Promise<Response>((resolve) => {
          pending.set(url, resolve);
        });
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    installEarlyCapture();
    // Settled before init: drained from the early queue.
    await globalThis.fetch("/api/participants");
    // Still on the wire at init: delivered through the early late sink.
    const inFlight = globalThis.fetch("/held/api/disputes");

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      network: true,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    pending.get("/held/api/disputes")?.(appResponse());
    await inFlight;

    // Issued by the app's first render, after init and before the policy: one
    // that settles inside the window and one that settles after it.
    await globalThis.fetch("/api/me/notifications");
    const acrossPolicy = globalThis.fetch("/held/api/search");

    answerConfig?.();
    await configAnswer;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    pending.get("/held/api/search")?.(appResponse());
    await acrossPolicy;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await logger.stop();

    const events = delivered(transport);
    const requests = events.filter((event) => event.k === "net.req");
    const responses = events.filter((event) => event.k === "net.res");
    const appUrl = (event: BugEvent) => String(event.d?.url);

    expect(requests.map(appUrl).sort()).toEqual(
      responses.map(appUrl).sort(),
    );
    for (const url of [
      "/api/participants",
      "/held/api/disputes",
      "/api/me/notifications",
      "/held/api/search",
    ]) {
      const request = requests.find((event) => appUrl(event).includes(url));
      const response = responses.find((event) => appUrl(event).includes(url));
      expect(request, `net.req for ${url}`).toBeDefined();
      expect(response, `net.res for ${url}`).toBeDefined();
      expect(request?.d?.id).toBe(response?.d?.id);
      expect(request?.d?.requestId).toBe(response?.d?.requestId);
      expect(typeof request?.d?.requestId).toBe("string");
    }
    expect(new Set(requests.map((event) => event.d?.id)).size).toBe(4);
  });


  // The hold must never become a way for evidence to reach the wire after the
  // host said no. A decision against capture discards it.
  it("discards what it held when consent is refused", async () => {
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config"))
        return new Promise<Response>(() => {});
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
      consentMode: "explicit",
    });

    logger.mark("before-the-answer");
    logger.consent(false);
    await logger.stop();

    expect(delivered(transport).filter((e) => e.k === "mark")).toHaveLength(0);
  });

  // Consent answered late is the other undecided window, and it resolves the
  // same way: the first screen is still there when the answer arrives.
  it("replays what it held when consent is granted", async () => {
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config"))
        return Promise.resolve(new Response(RECOGNIZED_POLICY));
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      network: true,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
      consentMode: "explicit",
    });

    await globalThis.fetch("/api/participants");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    logger.consent(true);
    await logger.stop();

    const events = delivered(transport);
    const forUrl = (kind: string) =>
      events.filter(
        (event) =>
          event.k === kind && String(event.d?.url).includes("/api/participants"),
      );
    expect(forUrl("net.req")).toHaveLength(1);
    expect(forUrl("net.res")).toHaveLength(1);
    expect(forUrl("net.req")[0]?.d?.id).toBe(forUrl("net.res")[0]?.d?.id);
  });

  it("opens the gate on the local config, and records the gap, when the config route never answers", async () => {
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config"))
        return Promise.reject(new Error("blocked by client"));
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    await vi.advanceTimersByTimeAsync(REMOTE_POLICY_TIMEOUT_MS + 1);
    logger.mark("after-the-wait");
    vi.useRealTimers();
    await logger.stop();

    const events = delivered(transport);
    expect(events.filter((event) => event.k === "mark")).toHaveLength(1);
    const gaps = events.filter(
      (event) => event.k === CAPTURE_GAP_EVENT_KIND,
    );
    expect(gaps.map((event) => event.d?.reason)).toContain(
      "policy_unavailable",
    );
  });

  it("bounds the wait when the config route answers with no policy at all", async () => {
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config"))
        return Promise.resolve(new Response("{}"));
      return Promise.resolve(appResponse());
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    // An unrecognized body must never count as a policy, so capture stays
    // locked the moment it lands. What must not happen is that it stays locked
    // for the life of the session.
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (logger as unknown as { remotePolicyReady: boolean }).remotePolicyReady,
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(REMOTE_POLICY_TIMEOUT_MS + 1);
    logger.mark("after-the-empty-policy");
    vi.useRealTimers();
    await logger.stop();

    const events = delivered(transport);
    expect(events.filter((event) => event.k === "mark")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.k === CAPTURE_GAP_EVENT_KIND)
        .map((event) => event.d?.reason),
    ).toContain("policy_unavailable");
  });
});
