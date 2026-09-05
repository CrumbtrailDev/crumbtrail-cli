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
import { installEarlyCapture, uninstallEarlyCapture } from "../early-capture";
import {
  CAPTURE_GAP_EVENT_KIND,
  DEFAULT_CONFIG,
  type BugEvent,
  type CrumbtrailConfig,
} from "../types";
import { reapplyPolicyToHeldEvent } from "../admission-hold";
import { WS_MAX_FRAME_BYTES } from "../collectors/websocket";
import { WORKER_MAX_MESSAGE_BYTES } from "../collectors/worker";

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

    expect(requests.map(appUrl).sort()).toEqual(responses.map(appUrl).sort());
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
      consentMode: "required",
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
      consentMode: "required",
    });

    await globalThis.fetch("/api/participants");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    logger.consent(true);
    await logger.stop();

    const events = delivered(transport);
    const forUrl = (kind: string) =>
      events.filter(
        (event) =>
          event.k === kind &&
          String(event.d?.url).includes("/api/participants"),
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
    const gaps = events.filter((event) => event.k === CAPTURE_GAP_EVENT_KIND);
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

/**
 * A held event was BUILT under the local config. The policy that releases it may
 * also have narrowed what may be captured at all, so release re-asks every
 * question the built event can still answer and drops what no longer passes.
 * Each case here tightens exactly one control and proves the held events obey it.
 */
describe("a policy that tightens while events are held", () => {
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

  /**
   * Holds one request carrying a secret-shaped body, then answers the config
   * route with `policy`, then returns everything the transport received.
   */
  async function holdThenApply(
    policy: Record<string, unknown>,
    options: {
      url?: string;
      body?: string;
      init?: Record<string, unknown>;
      appResponse?: () => Response;
    } = {},
  ): Promise<BugEvent[]> {
    let answerConfig: (() => void) | undefined;
    const configAnswer = new Promise<Response>((resolve) => {
      answerConfig = () => resolve(new Response(JSON.stringify(policy)));
    });
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config")) return configAnswer;
      return Promise.resolve((options.appResponse ?? appResponse)());
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
      ...options.init,
    });

    await globalThis.fetch(options.url ?? "/api/kyc", {
      method: "POST",
      headers: { "content-type": "application/json", "x-secret": "value" },
      body: options.body ?? JSON.stringify({ ssn: "123-45-6789" }),
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    answerConfig?.();
    await configAnswer;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await logger.stop();
    return delivered(transport);
  }

  it("drops a held request for a URL the policy now excludes", async () => {
    const events = await holdThenApply({
      killSwitch: false,
      network: { excludeUrls: ["/api/kyc"] },
    });
    expect(
      events.filter((event) => String(event.d?.url).includes("/api/kyc")),
    ).toHaveLength(0);
    // The loss is declared rather than silent, and under the reason that says
    // the policy dropped it rather than the reason that says a buffer filled.
    expect(
      events
        .filter((event) => event.k === CAPTURE_GAP_EVENT_KIND)
        .map((event) => event.d?.reason),
    ).toContain("policy_tightened");
  });

  // Every query value is redacted before an event is built, so an exclusion
  // pattern written against one can only match the URL the application asked
  // for. That copy lives on the hold entry and nowhere else.
  it("matches an exclusion against the raw URL, not the redacted one", async () => {
    const events = await holdThenApply(
      { killSwitch: false, network: { excludeUrls: ["plan=gold"] } },
      { url: "/api/kyc?plan=gold" },
    );
    expect(
      events.filter((event) => event.k === "net.req" || event.k === "net.res"),
    ).toHaveLength(0);
    // And the raw URL was not smuggled onto the released events to get there.
    expect(JSON.stringify(events)).not.toContain("plan=gold");
  });

  // `bodyMeta.data` is a parsed copy of the response body. Re-redacting `d.body`
  // and leaving it alone ships the cleartext through the parsed view, which is
  // the field the deny rule was aimed at.
  it("rebuilds the parsed response view after re-redacting the body", async () => {
    const secretResponse = () =>
      new Response(JSON.stringify({ coupon: "SAVE50", ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const before = await holdThenApply(
      { killSwitch: false },
      { appResponse: secretResponse },
    );
    const held = before.find((event) => event.k === "net.res");
    // Guard: without the deny rule the parsed view really does carry the field,
    // so the assertion below is testing the pass and not an empty object.
    expect(
      (held?.d?.bodyMeta as { data?: Record<string, unknown> } | undefined)
        ?.data,
    ).toMatchObject({ coupon: "SAVE50" });

    const events = await holdThenApply(
      { killSwitch: false, redaction: { denyFields: ["coupon"] } },
      { appResponse: secretResponse },
    );
    const response = events.find((event) => event.k === "net.res");
    expect(response).toBeDefined();
    expect(JSON.stringify(response)).not.toContain("SAVE50");
    // The size facts survive; the parsed view agrees with the redacted body.
    const meta = response?.d?.bodyMeta as
      { ct?: string; data?: Record<string, unknown> } | undefined;
    expect(meta?.ct).toBe("json");
    // Rebuilt rather than deleted: the parsed view still exists and now shows
    // the placeholder, so a reader can see the field was there and was removed.
    expect(meta?.data).toMatchObject({ ok: true });
    expect(JSON.stringify(meta?.data)).toContain("[REDACTED]");
    expect(JSON.stringify(meta?.data)).not.toContain("SAVE50");
  });

  it("drops held events of a collector the policy turned off", async () => {
    const events = await holdThenApply({
      killSwitch: false,
      collectors: { network: false },
    });
    expect(
      events.filter((event) => event.k === "net.req" || event.k === "net.res"),
    ).toHaveLength(0);
  });

  it("re-redacts a held body under denyFields the policy added", async () => {
    const events = await holdThenApply(
      {
        killSwitch: false,
        redaction: { denyFields: ["coupon"] },
      },
      { body: JSON.stringify({ coupon: "SAVE50" }) },
    );
    const bodies = JSON.stringify(
      events.filter((event) => event.k === "net.req"),
    );
    expect(bodies).not.toContain("SAVE50");
    expect(events.filter((event) => event.k === "net.req").length).toBe(1);
  });

  // `captureInputValues: false` is the one-way switch that turns every input
  // into a placeholder. A value typed on the first screen is held, so this is
  // the only place the switch can still reach it.
  it("blanks a held input value when the policy turns input capture off", async () => {
    let answerConfig: (() => void) | undefined;
    const configAnswer = new Promise<Response>((resolve) => {
      answerConfig = () =>
        resolve(
          new Response(
            JSON.stringify({
              killSwitch: false,
              redaction: { captureInputValues: false },
            }),
          ),
        );
    });
    globalThis.fetch = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config")) return configAnswer;
      return Promise.resolve(appResponse());
    }) as unknown as typeof globalThis.fetch;

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      ...QUIET,
      interactions: true,
      transportInstance: transport,
      httpEndpoint: "https://api.crumbtrail.test",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
    });

    const field = document.createElement("input");
    field.name = "search";
    field.value = "Sofia Restrepo";
    document.body.appendChild(field);
    field.dispatchEvent(new Event("input", { bubbles: true }));

    answerConfig?.();
    await configAnswer;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await logger.stop();
    field.remove();

    const events = delivered(transport);
    const inputs = events.filter((event) => event.k === "inp");
    expect(inputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(inputs)).not.toContain("Sofia Restrepo");
    // Held, the value was the character-shape mask the default policy produces,
    // which still carries its length and word count. The opt-out replaces the
    // value outright, and it has to reach the held event to mean anything.
    for (const event of inputs) expect(event.d?.val).toBe("[REDACTED]");
  });

  it("strips held request headers when the policy turns header capture off", async () => {
    const withHeaders = await holdThenApply({ killSwitch: false });
    expect(
      withHeaders.some(
        (event) => event.k === "net.req" && event.d?.hdrs !== undefined,
      ),
    ).toBe(true);

    const withoutHeaders = await holdThenApply({
      killSwitch: false,
      network: { captureHeaders: false },
    });
    expect(
      withoutHeaders.some(
        (event) => event.k === "net.req" && event.d?.hdrs !== undefined,
      ),
    ).toBe(false);
  });

  it("summarizes a held body the policy's lowered size cap no longer allows", async () => {
    const big = JSON.stringify({ note: "x".repeat(4_000) });
    const events = await holdThenApply(
      { killSwitch: false, network: { maxBodySize: 64 } },
      { body: big },
    );
    const request = events.find((event) => event.k === "net.req");
    expect(request).toBeDefined();
    // Over the cap the body is replaced by a summary that says so, rather than
    // riding out at the size the looser config allowed.
    expect(request?.d?.body).toBeUndefined();
    expect(request?.d?.bodySummary).toMatchObject({
      action: "summarized",
      reason: "payload_too_large",
      limit: 64,
    });
  });

  // A shed visitor uploads nothing. The hold is the third place events rest,
  // after the bus buffer and the ring buffer, and it holds the first screen.
  it("uploads nothing held when the policy sheds the session", async () => {
    const events = await holdThenApply({
      killSwitch: false,
      sampling: { captureSampleRate: 0 },
    });
    expect(
      events.filter((event) => event.k === "net.req" || event.k === "net.res"),
    ).toHaveLength(0);
  });
});

describe("the hold and the page lifecycle", () => {
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

  // Events held before a page hide belong to the session that is ending. Carried
  // across, they would surface in the next session with pre-suspend timestamps.
  it("does not carry events held before a page hide into the next session", async () => {
    let answerConfig: (() => void) | undefined;
    const configAnswer = new Promise<Response>((resolve) => {
      answerConfig = () => resolve(new Response(RECOGNIZED_POLICY));
    });
    const fetchStub = vi.fn().mockImplementation((input: unknown) => {
      if (String(input).includes("/api/capture-config")) return configAnswer;
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
      endOnPageHide: true,
    });

    await globalThis.fetch("/api/participants");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const internals = logger as unknown as {
      closeForLifecycle(immediate: boolean): Promise<void>;
      resumeFromLifecycle(): Promise<void> | undefined;
    };
    await internals.closeForLifecycle(true);
    // Everything the transport saw up to here belongs to the session that ended.
    const beforeResume = transport.sendEvents.mock.calls.length;
    await internals.resumeFromLifecycle();

    answerConfig?.();
    await configAnswer;
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await logger.stop();

    const afterResume = transport.sendEvents.mock.calls
      .slice(beforeResume)
      .flatMap((call) => call[0] as BugEvent[]);
    expect(
      afterResume.filter((event) =>
        String(event.d?.url).includes("/api/participants"),
      ),
    ).toHaveLength(0);
  });
});

// The release pass, exercised directly.
//
// Some of what it has to get right is only reachable end to end by driving a
// DOM snapshot or a WebSocket frame through the whole init window. These call
// it with a held event and the policy that arrived, which is exactly the pair
// it sees in `releasePendingAdmissionEvents`.
describe("the release pass, per event kind", () => {
  const LOOSE = { maskAllText: false, maskAllInputs: false };
  const CONTEXT = { heldMasking: LOOSE, samplingShed: false };

  /**
   * The event was held under LOOSE masking, and the arriving policy leaves it
   * loose unless a case says otherwise. Masking is on by default, so without
   * this baseline every case would read as a tightening and drop everything.
   */
  function apply(
    event: BugEvent,
    // `maskAllText` and `maskAllInputs` are typed as the literal `true`, so a
    // config with either off cannot be written in TypeScript. A JavaScript host
    // can still pass one — the CLI writes an init block into JS apps — which is
    // the state the masking branch of the release pass exists for.
    config: Record<string, unknown>,
    context = CONTEXT,
  ): BugEvent | undefined {
    return reapplyPolicyToHeldEvent(
      event,
      { ...DEFAULT_CONFIG, ...LOOSE, ...config } as CrumbtrailConfig,
      context,
    );
  }

  // `snap` is the storage collector's snapshot and `dom.snap` is the DOM one.
  // Reading either as the other drops the wrong events and guards neither.
  it("routes snap to the storage switch and dom.snap to the DOM switch", () => {
    const storageSnap: BugEvent = { t: 1, k: "snap", d: { keys: 3 } };
    const domSnap: BugEvent = { t: 1, k: "dom.snap", d: { html: "<p>x</p>" } };

    expect(apply(storageSnap, { storage: false })).toBeUndefined();
    expect(apply(storageSnap, { domSnapshot: false })).toBeDefined();
    expect(apply(domSnap, { domSnapshot: false })).toBeUndefined();
    expect(apply(domSnap, { storage: false })).toBeDefined();
  });

  // Page content is masked as it is captured, from a DOM that is gone by
  // release. A policy that tightens masking cannot be applied to it after the
  // fact, so the event goes rather than shipping under the looser mode.
  it("drops content built under looser masking when the policy tightens it", () => {
    const tightened = { maskAllText: true, maskAllInputs: true };
    const domSnap: BugEvent = {
      t: 1,
      k: "dom.snap",
      d: { html: "<p>jane@acme.com</p>" },
    };
    expect(apply(domSnap, tightened)).toBeUndefined();
    // Unchanged masking is not a tightening, so the same event survives.
    expect(apply(domSnap, {})).toBeDefined();
    // A storage snapshot is not page content and is not masking dependent.
    expect(apply({ t: 1, k: "snap", d: { keys: 3 } }, tightened)).toBeDefined();
  });

  // An interaction carries the element's rendered label. A button reading
  // "Continue as jane@acme.com" holds that address with nothing left to
  // re-mask it from.
  it("drops a held click and input when the policy tightens masking", () => {
    const tightened = { maskAllText: true, maskAllInputs: true };
    const click: BugEvent = {
      t: 1,
      k: "clk",
      d: { text: "Continue as jane@acme.com", sel: "button" },
    };
    const input: BugEvent = { t: 1, k: "inp", d: { val: "Sofia" } };
    expect(apply(click, tightened)).toBeUndefined();
    expect(apply(input, tightened)).toBeUndefined();
    expect(apply(click, {})).toBeDefined();
    expect(apply(input, {})).toBeDefined();
  });

  // A frame and a worker message have their own ceilings, well under the
  // network body limit. Re-capping them at the body limit would let a held
  // frame out at a size the live collector never allows.
  it("re-caps a held frame at the frame limit, not the body limit", () => {
    const long = "x".repeat(WS_MAX_FRAME_BYTES + 500);
    const frame: BugEvent = { t: 1, k: "net.ws", d: { body: long } };
    const message: BugEvent = {
      t: 1,
      k: "worker.msg",
      d: { body: "y".repeat(WORKER_MAX_MESSAGE_BYTES + 500) },
    };
    // The network body limit is far above both ceilings, so a pass that used it
    // would leave these bodies whole.
    const config = { networkMaxBodySize: 100_000 };
    for (const [event, limit] of [
      [frame, WS_MAX_FRAME_BYTES],
      [message, WORKER_MAX_MESSAGE_BYTES],
    ] as const) {
      const released = apply(event, config);
      expect(released?.d?.body).toBeUndefined();
      expect(released?.d?.bodySummary).toMatchObject({
        reason: "payload_too_large",
        limit,
      });
    }
  });

  // A gap record is the thing that says capture lost something. It survives
  // every tightening, including a sample rate that sheds everything else.
  it("keeps a capture gap through a shed session", () => {
    const gap: BugEvent = {
      t: 1,
      k: CAPTURE_GAP_EVENT_KIND,
      d: { reason: "policy_tightened", droppedEventCount: 2 },
    };
    expect(apply(gap, {}, { heldMasking: LOOSE, samplingShed: true })).toBe(
      gap,
    );
    expect(
      apply(
        { t: 1, k: "clk", d: {} },
        {},
        { heldMasking: LOOSE, samplingShed: true },
      ),
    ).toBeUndefined();
  });
});
