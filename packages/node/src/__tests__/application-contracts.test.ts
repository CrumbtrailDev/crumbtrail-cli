import { afterEach, describe, expect, it, vi } from "vitest";
import { clearProcessSessionId, setProcessSessionId } from "../process-session";
import {
  beginApplicationExpectation,
  clearApplicationExpectationSession,
  resetApplicationContractStateForTests,
  sendApplicationResponseAssertions,
} from "../application-contracts";
import { runInBackendRequestContext } from "../request-context";

function acceptedResponse() {
  return { ok: true, status: 200, text: async () => '{"ok":true}' };
}

describe("Node application contract transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetApplicationContractStateForTests();
    clearProcessSessionId();
  });

  it("sends selected response facts with process and request correlation only", async () => {
    setProcessSessionId("ses_response");
    const fetch = vi.fn().mockResolvedValue(acceptedResponse());
    const response = {
      data: {
        total: 90,
        note: "a private sentence that must stay local",
      },
    };

    const result = await runInBackendRequestContext(
      {
        sessionId: "ses_browser",
        requestId: "req_response",
        sessionIdSource: "header",
      },
      () =>
        sendApplicationResponseAssertions({
          response,
          facts: [
            {
              name: "cart_total",
              operator: "equals",
              expected: 100,
              path: "data.total",
            },
          ],
          endpoint: "https://capture.example",
          fetch,
        }),
    );

    expect(result).toMatchObject({
      accepted: true,
      acceptedCount: 1,
      results: [{ accepted: true, passed: false, delivered: true }],
    });
    const request = fetch.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(request.body) as {
      events: Array<{ sessionId?: string; d: Record<string, unknown> }>;
    };
    expect(body.events[0]).toMatchObject({
      sessionId: "ses_browser",
      d: {
        name: "cart_total",
        actual: 90,
        requestId: "req_response",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private sentence");
    expect(JSON.stringify(body)).not.toContain("note");
  });

  it("returns an explicit no-session result without starting delivery", async () => {
    const fetch = vi.fn();
    await expect(
      sendApplicationResponseAssertions({
        response: { data: { total: 1 } },
        facts: [
          {
            name: "total",
            operator: "equals",
            expected: 1,
            path: "data.total",
          },
        ],
        fetch,
      }),
    ).resolves.toEqual({
      accepted: false,
      acceptedCount: 0,
      results: [],
      rejection: "correlation_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports delivery failure as false without changing the semantic result", async () => {
    setProcessSessionId("ses_delivery");
    const fetch = vi.fn().mockRejectedValue(new Error("network secret"));
    const result = await sendApplicationResponseAssertions({
      response: { data: { status: "wrong" } },
      facts: [
        {
          name: "status",
          operator: "equals",
          expected: "right",
          path: "data.status",
        },
      ],
      endpoint: "https://capture.example",
      fetch,
      retries: 0,
      sleep: async () => {},
    });

    expect(result.results[0]).toMatchObject({
      accepted: true,
      passed: false,
      delivered: false,
    });
    expect(JSON.stringify(result)).not.toContain("network secret");
  });

  it("emits one missed expectation at deadline and uses the same transport", async () => {
    vi.useFakeTimers();
    setProcessSessionId("ses_expectation");
    const fetch = vi.fn().mockResolvedValue(acceptedResponse());
    const result = beginApplicationExpectation({
      name: "inventory_update",
      kind: "update",
      deadlineMs: 25,
      endpoint: "https://capture.example",
      fetch,
    });

    expect(result.accepted).toBe(true);
    vi.advanceTimersByTime(25);
    await vi.runAllTimersAsync();

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(request.body) as {
      events: Array<{
        k: string;
        sessionId?: string;
        d: Record<string, unknown>;
      }>;
    };
    expect(body.events[0]).toEqual({
      t: expect.any(Number),
      k: "app.expectation.missed",
      sessionId: "ses_expectation",
      d: {
        name: "inventory_update",
        kind: "update",
        deadlineMs: 25,
        reason: "deadline",
      },
    });
    expect(result.handle?.satisfy()).toBe(false);
  });

  it("emits pending work once when its session is cleared", async () => {
    setProcessSessionId("ses_shutdown");
    const fetch = vi.fn().mockResolvedValue(acceptedResponse());
    const result = beginApplicationExpectation({
      name: "external_sync",
      kind: "external",
      deadlineMs: 10_000,
      endpoint: "https://capture.example",
      fetch,
    });

    clearApplicationExpectationSession("ses_shutdown");
    await Promise.resolve();
    expect(result.handle?.cancel()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as { body: string }).body,
    ) as { events: Array<{ d: Record<string, unknown> }> };
    expect(body.events[0]?.d).toMatchObject({
      name: "external_sync",
      kind: "external",
      reason: "session_shutdown",
    });
  });
});
