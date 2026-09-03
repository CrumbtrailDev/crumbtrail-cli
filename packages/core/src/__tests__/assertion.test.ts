import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../crumbtrail";
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

  it("caps valid assertions per session while invalid inputs do not consume the cap", async () => {
    const sink = transport();
    const logger = Crumbtrail.init({
      transportInstance: sink,
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
});
