import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
import type { SessionStore } from "../session-store";
import {
  APPLICATION_ASSERTION_EVENT_KIND,
  APPLICATION_ASSERTION_TIMESTAMP_MAX,
  APPLICATION_ASSERTION_TIMESTAMP_MIN,
  MAX_APPLICATION_ASSERTIONS_PER_SESSION,
  buildApplicationAssertionData,
  buildApplicationAssertionEvent,
  evaluateApplicationAssertion,
} from "../index";

function transport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

describe("application assertions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("evaluates the fixed operators deterministically", () => {
    expect(evaluateApplicationAssertion("equals", 3, 3)).toBe(true);
    expect(evaluateApplicationAssertion("not_equals", "open", "closed")).toBe(
      true,
    );
    expect(evaluateApplicationAssertion("greater_or_equal", 3, 4)).toBe(true);
    expect(evaluateApplicationAssertion("less_or_equal", 3, 4)).toBe(false);
  });

  it("rejects prose, secrets, objects, non-finite values, and mismatched types", () => {
    expect(
      buildApplicationAssertionData({
        name: "checkout_total",
        operator: "equals",
        expected: "a sentence",
        actual: "a sentence",
      }).accepted,
    ).toBe(false);
    expect(
      buildApplicationAssertionData({
        name: "checkout_total",
        operator: "equals",
        expected: "sk_live_123",
        actual: "ok",
      }).accepted,
    ).toBe(false);
    expect(
      buildApplicationAssertionData({
        name: "checkout_total",
        operator: "equals",
        expected: { amount: 1 } as never,
        actual: { amount: 1 } as never,
      }).accepted,
    ).toBe(false);
    expect(
      buildApplicationAssertionData({
        name: "checkout_total",
        operator: "equals",
        expected: Number.NaN,
        actual: 1,
      }).accepted,
    ).toBe(false);
    expect(
      buildApplicationAssertionData({
        name: "checkout_total",
        operator: "equals",
        expected: 1,
        actual: "1",
      }).accepted,
    ).toBe(false);
  });

  it("uses the shared deny-biased policy for semantic names and credentials", () => {
    for (const name of [
      "api_token",
      "client_secret",
      "password",
      "customer_email",
      "session_id",
    ]) {
      expect(
        buildApplicationAssertionData({
          name,
          operator: "equals",
          expected: "ready",
          actual: "ready",
        }),
      ).toEqual({ accepted: false, rejection: "invalid_name" });
    }
    expect(
      buildApplicationAssertionData({
        name: "order_status",
        operator: "equals",
        expected: "PAYMENT_DECLINED",
        actual: "PAYMENT_DECLINED",
      }).accepted,
    ).toBe(true);
    expect(
      buildApplicationAssertionData({
        name: "order_reference",
        operator: "equals",
        expected: "AKIAIOSFODNN7EXAMPLE",
        actual: "AKIAIOSFODNN7EXAMPLE",
      }),
    ).toEqual({ accepted: false, rejection: "invalid_expected" });
    expect(
      buildApplicationAssertionData({
        name: "order_reference",
        operator: "equals",
        expected: "Bearer super_secret_value",
        actual: "Bearer super_secret_value",
      }),
    ).toEqual({ accepted: false, rejection: "invalid_expected" });
  });

  it("rejects null, non-plain records, throwing proxies, and changing getters", () => {
    expect(() => buildApplicationAssertionData(null as never)).not.toThrow();
    expect(buildApplicationAssertionData(null as never)).toEqual({
      accepted: false,
      rejection: "invalid_options",
    });
    expect(
      buildApplicationAssertionData(
        Object.create({
          name: "order_status",
          operator: "equals",
          expected: "ready",
          actual: "ready",
        }) as never,
      ),
    ).toEqual({ accepted: false, rejection: "invalid_options" });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(buildApplicationAssertionEvent(revoked.proxy as never, 1)).toEqual({
      accepted: false,
      rejection: "invalid_options",
    });

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile proxy");
        },
      },
    );
    expect(buildApplicationAssertionEvent(hostile as never, 1)).toEqual({
      accepted: false,
      rejection: "invalid_options",
    });

    let expectedReads = 0;
    const changingGetter = {
      name: "order_status",
      operator: "equals" as const,
      get expected() {
        expectedReads += 1;
        return expectedReads === 1 ? "ready" : "sk_live_changed";
      },
      actual: "ready",
    };
    const built = buildApplicationAssertionEvent(changingGetter, 1);
    expect(built.accepted).toBe(true);
    expect(built.event?.d.expected).toBe("ready");
    expect(expectedReads).toBe(1);
  });

  it.each([
    { label: "fractional", timestamp: 1.5 },
    {
      label: "negative",
      timestamp: APPLICATION_ASSERTION_TIMESTAMP_MIN - 1,
    },
    {
      label: "too large",
      timestamp: APPLICATION_ASSERTION_TIMESTAMP_MAX + 1,
    },
    { label: "unsafe", timestamp: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects $label assertion timestamps", ({ timestamp }) => {
    expect(
      buildApplicationAssertionEvent(
        {
          name: "checkout_total",
          operator: "equals",
          expected: 1,
          actual: 1,
        },
        timestamp,
      ),
    ).toEqual({ accepted: false, rejection: "invalid_timestamp" });
  });

  it("accepts the canonical timestamp boundaries", () => {
    for (const timestamp of [
      APPLICATION_ASSERTION_TIMESTAMP_MIN,
      APPLICATION_ASSERTION_TIMESTAMP_MAX,
    ]) {
      expect(
        buildApplicationAssertionEvent(
          {
            name: "checkout_total",
            operator: "equals",
            expected: 1,
            actual: 1,
          },
          timestamp,
        ).accepted,
      ).toBe(true);
    }
  });

  it("emits only fixed bounded fields and includes the active correlation", async () => {
    const sink = transport();
    const logger = Crumbtrail.init({
      transportInstance: sink,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });

    expect(
      logger.assert({
        name: "cart_total",
        operator: "equals",
        expected: 100,
        actual: 90,
        requestId: "req_123",
        traceId: "trace_123",
      }),
    ).toBe(false);
    expect(sink.sendEvents).toHaveBeenCalledWith([
      {
        t: expect.any(Number),
        k: APPLICATION_ASSERTION_EVENT_KIND,
        d: {
          name: "cart_total",
          operator: "equals",
          expected: 100,
          actual: 90,
          passed: false,
          valueType: "number",
          requestId: "req_123",
          traceId: "trace_123",
        },
        sessionId: logger.getSessionId(),
      },
    ]);
    await logger.stop();
  });

  it("reports and counts only assertions admitted by capture policy", async () => {
    const sink = transport();
    const logger = Crumbtrail.init({
      transportInstance: sink,
      consentMode: "required",
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });

    expect(
      logger.reportAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
      }),
    ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
    logger.consent(true);
    expect(
      logger.reportAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
      }).accepted,
    ).toBe(true);
    await logger.stop();
  });

  it("does not admit assertions while sampling or remote policy is closed", async () => {
    const sampledOut = Crumbtrail.init({
      transportInstance: transport(),
      captureSampleRate: 0,
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    } as never);
    expect(
      sampledOut.reportAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
      }),
    ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
    await sampledOut.stop();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    const remote = Crumbtrail.init({
      transportInstance: transport(),
      httpEndpoint: "https://capture.example",
      httpAuthToken: "ctkey_live",
      remoteConfig: true,
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    expect(
      remote.reportAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
      }),
    ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
    await remote.stop();
  });

  it("does not admit assertions after the instance lifecycle closes", async () => {
    const logger = Crumbtrail.init({
      transportInstance: transport(),
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    await logger.stop();
    expect(
      logger.reportAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
      }),
    ).toEqual({ accepted: false, rejection: "capture_not_admitted" });
  });

  it("caps valid assertions per session while invalid inputs do not consume the cap", async () => {
    const sink = transport();
    const logger = Crumbtrail.init({
      transportInstance: sink,
      sessionPersistence: "memory",
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    expect(
      logger.reportAssertion({
        name: "bad",
        operator: "equals",
        expected: { no: "objects" } as never,
        actual: { no: "objects" } as never,
      }).rejection,
    ).toBe("invalid_expected");
    for (let i = 0; i < MAX_APPLICATION_ASSERTIONS_PER_SESSION; i += 1) {
      expect(
        logger.reportAssertion({
          name: "item_count",
          operator: "greater_or_equal",
          expected: 0,
          actual: i,
        }).accepted,
      ).toBe(true);
    }
    expect(
      logger.reportAssertion({
        name: "item_count",
        operator: "equals",
        expected: 1,
        actual: 1,
      }),
    ).toEqual({ accepted: false, rejection: "session_cap_reached" });
    const assertionEvents = sink.sendEvents.mock.calls
      .flatMap((call) => call[0] as Array<{ k?: string }>)
      .filter((event) => event.k === "app.assertion");
    expect(assertionEvents).toHaveLength(
      MAX_APPLICATION_ASSERTIONS_PER_SESSION,
    );
    await logger.stop();
  }, 15_000);

  it("persists the assertion count for a reused browser session without values", async () => {
    let persisted: Parameters<SessionStore["write"]>[0] | undefined;
    const sessionStore: SessionStore = {
      read: () => persisted,
      write: (session) => {
        persisted = { ...session };
      },
    };
    const first = Crumbtrail.init({
      transportInstance: transport(),
      sessionPersistence: "session",
      sessionStore,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    for (let i = 0; i < MAX_APPLICATION_ASSERTIONS_PER_SESSION; i += 1) {
      expect(
        first.reportAssertion({
          name: "item_count",
          operator: "greater_or_equal",
          expected: 0,
          actual: i,
        }).accepted,
      ).toBe(true);
    }
    const sessionId = first.getSessionId();
    await first.stop();
    expect(persisted).toEqual({
      id: sessionId,
      lastActivity: expect.any(Number),
      applicationAssertionCount: MAX_APPLICATION_ASSERTIONS_PER_SESSION,
    });
    expect(JSON.stringify(persisted)).not.toContain("item_count");

    const second = Crumbtrail.init({
      transportInstance: transport(),
      sessionPersistence: "session",
      sessionStore,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    expect(second.getSessionId()).toBe(sessionId);
    expect(
      second.reportAssertion({
        name: "item_count",
        operator: "equals",
        expected: 1,
        actual: 1,
      }),
    ).toEqual({ accepted: false, rejection: "session_cap_reached" });
    await second.stop();
  });
});
