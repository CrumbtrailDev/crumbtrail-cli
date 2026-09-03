import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import {
  APPLICATION_EXPECTATION_MISSED_EVENT_KIND,
  APPLICATION_RESPONSE_ASSERTION_EVENT_KIND,
  MAX_APPLICATION_EXPECTATIONS_PER_SESSION,
  MAX_APPLICATION_RESPONSE_FACTS_PER_CALL,
  MAX_APPLICATION_RESPONSE_SELECTOR_SCAN,
  ApplicationExpectationManager,
  buildApplicationExpectationMissedEvent,
  checkApplicationResponse,
} from "../index";

const timestamp = 1_700_000_000_000;

describe("application response contracts", () => {
  it("checks exact paths and emits only the selected bounded fact", () => {
    const response = {
      data: {
        total: 90,
        message: "customer prose that must not cross telemetry",
      },
      privateToken: "sk_live_do_not_capture",
    };

    const result = checkApplicationResponse(
      response,
      [
        {
          name: "cart_total",
          operator: "equals",
          expected: 100,
          path: "data.total",
          requestId: "req_123",
          traceId: "trace_123",
        },
      ],
      timestamp,
      { sessionId: "ses_123" },
    );

    expect(result).toMatchObject({ accepted: true, acceptedCount: 1 });
    expect(result.results[0]).toMatchObject({ accepted: true, passed: false });
    expect(result.results[0]?.event).toEqual({
      t: timestamp,
      k: APPLICATION_RESPONSE_ASSERTION_EVENT_KIND,
      sessionId: "ses_123",
      d: {
        name: "cart_total",
        operator: "equals",
        expected: 100,
        actual: 90,
        passed: false,
        valueType: "number",
        source: "path",
        path: "data.total",
        requestId: "req_123",
        traceId: "trace_123",
      },
    });
    expect(JSON.stringify(result.results[0]?.event)).not.toContain(
      "customer prose",
    );
    expect(JSON.stringify(result.results[0]?.event)).not.toContain(
      "privateToken",
    );
  });

  it("selects one matching array item within the scan bound", () => {
    const result = checkApplicationResponse(
      {
        items: [
          { code: "other", total: 1 },
          { code: "wanted", total: 7 },
        ],
      },
      [
        {
          name: "selected_total",
          operator: "greater_or_equal",
          expected: 7,
          selector: {
            path: "items",
            match: { path: "code", expected: "wanted" },
            valuePath: "total",
          },
        },
      ],
      timestamp,
    );

    expect(result.results[0]).toMatchObject({ accepted: true, passed: true });
    expect(result.results[0]?.event?.d).toMatchObject({
      source: "selector",
      path: "items[*].total",
      actual: 7,
    });
  });

  it("rejects response bodies, prose, email values, tokens, and unsafe paths", () => {
    const cases = [
      {
        response: { data: { value: { nested: true } } },
        fact: { name: "result", operator: "equals", expected: 1, path: "data" },
        expected: "invalid_actual",
      },
      {
        response: { data: { message: "a whole sentence" } },
        fact: {
          name: "result",
          operator: "equals",
          expected: "ok",
          path: "data.message",
        },
        expected: "invalid_actual",
      },
      {
        response: { data: { email: "person@example.com" } },
        fact: {
          name: "result",
          operator: "equals",
          expected: "ok",
          path: "data.email",
        },
        expected: "invalid_actual",
      },
      {
        response: { data: { status: "ok" } },
        fact: {
          name: "status",
          operator: "equals",
          expected: "sk_live_secret",
          path: "data.status",
        },
        expected: "invalid_expected",
      },
      {
        response: { data: { status: "token_123" } },
        fact: {
          name: "status",
          operator: "equals",
          expected: "ok",
          path: "data.status",
        },
        expected: "invalid_actual",
      },
      {
        response: { data: { value: 1 } },
        fact: {
          name: "proto",
          operator: "equals",
          expected: 1,
          path: "data.__proto__.value",
        },
        expected: "invalid_path",
      },
      {
        response: { data: { privateToken: "abc123" } },
        fact: {
          name: "private_token",
          operator: "equals",
          expected: "abc123",
          path: "data.privateToken",
        },
        expected: "invalid_path",
      },
      {
        response: { data: { value: 1 } },
        fact: {
          name: "headers",
          operator: "equals",
          expected: 1,
          path: "headers.status",
        },
        expected: "invalid_path",
      },
    ] as const;

    for (const entry of cases) {
      const result = checkApplicationResponse(
        entry.response,
        [entry.fact],
        timestamp,
      );
      expect(result.results[0]?.rejection).toBe(entry.expected);
      expect(result.accepted).toBe(false);
    }
  });

  it("fails closed on accessors, revoked proxies, and selector over-scans", () => {
    const accessor = {} as { value?: number };
    Object.defineProperty(accessor, "value", {
      get: () => {
        throw new Error("must not run accessor");
      },
    });
    expect(
      checkApplicationResponse(
        { data: accessor },
        [
          {
            name: "value",
            operator: "equals",
            expected: 1,
            path: "data.value",
          },
        ],
        timestamp,
      ).results[0]?.rejection,
    ).toBe("path_accessor");

    const revoked = Proxy.revocable({ data: { value: 1 } }, {});
    revoked.revoke();
    expect(
      checkApplicationResponse(
        revoked.proxy,
        [
          {
            name: "value",
            operator: "equals",
            expected: 1,
            path: "data.value",
          },
        ],
        timestamp,
      ).results[0]?.rejection,
    ).toBe("path_unreadable");

    const items = Array.from(
      { length: MAX_APPLICATION_RESPONSE_SELECTOR_SCAN + 1 },
      (_, index) => ({ code: `code_${index}`, total: index }),
    );
    expect(
      checkApplicationResponse(
        { items },
        [
          {
            name: "selected_total",
            operator: "equals",
            expected: 999,
            selector: {
              path: "items",
              match: { path: "code", expected: "missing" },
              valuePath: "total",
            },
          },
        ],
        timestamp,
      ).results[0]?.rejection,
    ).toBe("selector_scan_limit_reached");
  });

  it("rejects oversized batches before reading the response", () => {
    let reads = 0;
    const response = new Proxy(
      { data: { value: 1 } },
      {
        get: () => {
          reads += 1;
          throw new Error("response getter must not run");
        },
      },
    );
    const facts = Array.from(
      { length: MAX_APPLICATION_RESPONSE_FACTS_PER_CALL + 1 },
      () => ({
        name: "value",
        operator: "equals" as const,
        expected: 1,
        path: "data.value",
      }),
    );

    expect(checkApplicationResponse(response, facts, timestamp)).toEqual({
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "fact_batch_limit_reached",
    });
    expect(reads).toBe(0);
  });
});

describe("application expectation lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits one missed event at the deadline and makes terminal races idempotent", () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const manager = new ApplicationExpectationManager({
      sessionId: "ses_expect",
      now: () => timestamp,
      emit: (event) => events.push(event),
    });
    const registered = manager.begin({
      name: "invoice_update",
      kind: "update",
      deadlineMs: 10,
      requestId: "req_expect",
    });

    expect(registered.accepted).toBe(true);
    expect(registered.handle?.satisfy()).toBe(true);
    expect(registered.handle?.cancel()).toBe(false);
    vi.advanceTimersByTime(10);
    expect(events).toHaveLength(0);

    const missed = manager.begin({
      name: "webhook_delivery",
      kind: "external",
      deadlineMs: 10,
      traceId: "trace_expect",
    });
    vi.advanceTimersByTime(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      t: timestamp,
      k: APPLICATION_EXPECTATION_MISSED_EVENT_KIND,
      sessionId: "ses_expect",
      d: {
        name: "webhook_delivery",
        kind: "external",
        deadlineMs: 10,
        reason: "deadline",
        traceId: "trace_expect",
      },
    });
    expect(missed.handle?.satisfy()).toBe(false);
    expect(missed.handle?.cancel()).toBe(false);
    vi.advanceTimersByTime(100);
    expect(events).toHaveLength(1);
  });

  it("does not retain an expectation when a timer callback wins during registration", () => {
    const events: unknown[] = [];
    const timer = { unref: vi.fn() };
    vi.stubGlobal("setTimeout", ((callback: () => void) => {
      callback();
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const manager = new ApplicationExpectationManager({
        sessionId: "ses_sync_timer",
        now: () => timestamp,
        emit: (event) => events.push(event),
      });
      const registered = manager.begin({
        name: "sync_timer",
        kind: "work",
        deadlineMs: 10,
      });

      expect(registered.accepted).toBe(true);
      expect(registered.handle?.satisfy()).toBe(false);
      expect(events).toHaveLength(1);
      expect((events[0] as { d: { reason: string } }).d.reason).toBe(
        "deadline",
      );
      expect(timer.unref).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("misses pending work once on stop and clears future lifecycle state", () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const manager = new ApplicationExpectationManager({
      sessionId: "ses_stop",
      now: () => timestamp,
      emit: (event) => events.push(event),
    });
    const pending = manager.begin({
      name: "queue_or_work",
      kind: "work",
      deadlineMs: 1_000,
    });
    manager.stop();
    manager.stop();
    expect(events).toHaveLength(1);
    expect((events[0] as { d: { reason: string } }).d.reason).toBe(
      "session_shutdown",
    );
    expect(pending.handle?.satisfy()).toBe(false);
    expect(
      manager.begin({ name: "later", kind: "queue", deadlineMs: 10 }),
    ).toEqual({ accepted: false, rejection: "session_stopped" });
    vi.advanceTimersByTime(2_000);
    expect(events).toHaveLength(1);
  });

  it("bounds registrations and rejects accessor-shaped declarations without throwing", () => {
    vi.useFakeTimers();
    const manager = new ApplicationExpectationManager({
      sessionId: "ses_cap",
      emit: () => {},
    });
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "name", { get: () => "secret" });
    expect(manager.begin(hostile as never)).toEqual({
      accepted: false,
      rejection: "invalid_name",
    });
    for (
      let index = 0;
      index < MAX_APPLICATION_EXPECTATIONS_PER_SESSION;
      index += 1
    ) {
      expect(
        manager.begin({
          name: `work_${index}`,
          kind: "work",
          deadlineMs: 1_000,
        }),
      ).toMatchObject({ accepted: true });
    }
    expect(
      manager.begin({ name: "overflow", kind: "work", deadlineMs: 1_000 }),
    ).toEqual({ accepted: false, rejection: "expectation_cap_reached" });
    expect(manager.begin(hostile as never)).toEqual({
      accepted: false,
      rejection: "expectation_cap_reached",
    });
  });

  it("rejects an invalid missed-event reason without building telemetry", () => {
    expect(
      buildApplicationExpectationMissedEvent(
        { name: "work", kind: "work", deadlineMs: 10 },
        "other" as never,
        timestamp,
      ),
    ).toEqual({ accepted: false, rejection: "invalid_options" });
  });
});

describe("application contracts through Crumbtrail", () => {
  it("refuses inactive capture without spending response capacity", async () => {
    const logger = Crumbtrail.init({ sessionPersistence: "memory" });
    const facts = [
      {
        name: "state",
        operator: "equals" as const,
        expected: "ready",
        path: "state",
      },
    ];
    for (let index = 0; index < 101; index += 1) {
      expect(
        logger.checkResponse({ state: "ready" }, facts).results[0],
      ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
    }
    expect(
      logger.expectSideEffect({ name: "work", kind: "work", deadlineMs: 100 }),
    ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
    await logger.stop();
  });

  it("retains response caps across restoration and counts only admitted events", async () => {
    const sink = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    let saved: import("../session-store").PersistedSession | undefined;
    const sessionStore = {
      read: () => saved,
      write: (value: import("../session-store").PersistedSession) => {
        saved = value;
      },
    };
    const options = {
      transportInstance: sink,
      sessionStore,
      flushBufferSize: 1,
      flushIntervalMs: 100_000,
    };
    const logger = Crumbtrail.init(options);
    const facts = [
      {
        name: "state",
        operator: "equals" as const,
        expected: "ready",
        path: "state",
      },
    ];
    const bus = (
      logger as unknown as { bus: { emit: (event: unknown) => boolean } }
    ).bus;
    const blocked = vi.spyOn(bus, "emit").mockReturnValue(false);
    expect(logger.checkResponse({ state: "ready" }, facts).accepted).toBe(
      false,
    );
    blocked.mockRestore();
    for (let index = 0; index < 100; index += 1)
      expect(logger.checkResponse({ state: "ready" }, facts).accepted).toBe(
        true,
      );
    expect(saved?.applicationResponseAssertionCount).toBe(100);
    await logger.stop();
    const resumed = Crumbtrail.init(options);
    expect(resumed.checkResponse({ state: "ready" }, facts).results[0]).toEqual(
      { accepted: false, rejection: "response_session_cap_reached" },
    );
    await resumed.stop();
  });

  it("flushes response mismatches and shutdown misses through the active session", async () => {
    const sink = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: sink,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });

    const response = logger.checkResponse(
      { data: { status: "wrong" } },
      [
        {
          name: "status",
          operator: "equals",
          expected: "right",
          path: "data.status",
        },
      ],
      { requestId: "req_contract" },
    );
    const expectation = logger.expectSideEffect({
      name: "external_sync",
      kind: "external",
      deadlineMs: 10_000,
    });

    await logger.stop();

    const events = sink.sendEvents.mock.calls.flatMap(
      (call) => call[0] as Array<{ k: string; d: Record<string, unknown> }>,
    );
    expect(response.results[0]).toMatchObject({
      accepted: true,
      passed: false,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          k: APPLICATION_RESPONSE_ASSERTION_EVENT_KIND,
          d: expect.objectContaining({
            name: "status",
            actual: "wrong",
            requestId: "req_contract",
          }),
        }),
        expect.objectContaining({
          k: APPLICATION_EXPECTATION_MISSED_EVENT_KIND,
          d: expect.objectContaining({
            name: "external_sync",
            reason: "session_shutdown",
          }),
        }),
      ]),
    );
    expect(expectation.handle?.satisfy()).toBe(false);
  });
});
