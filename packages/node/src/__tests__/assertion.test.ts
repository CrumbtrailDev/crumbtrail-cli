import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProcessSessionId,
  setProcessSessionId,
} from "../process-session";
import {
  resetApplicationAssertionCountsForTests,
  sendApplicationAssertion,
} from "../assertion";

describe("Node application assertions", () => {
  afterEach(() => {
    clearProcessSessionId();
    resetApplicationAssertionCountsForTests();
  });

  it("uses the process session and sends the bounded event", async () => {
    setProcessSessionId("ses_support_assertion");
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    });

    const result = await sendApplicationAssertion({
      name: "invoice_count",
      operator: "greater_or_equal",
      expected: 2,
      actual: 1,
      endpoint: "https://capture.example",
      fetch,
    });

    expect(result.accepted).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.delivered).toBe(true);
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string) as {
      sessionId: string;
      events: Array<{ k: string; sessionId?: string; d: Record<string, unknown> }>;
    };
    expect(body.sessionId).toBe("ses_support_assertion");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      k: "app.assertion",
      sessionId: "ses_support_assertion",
      d: {
        name: "invoice_count",
        operator: "greater_or_equal",
        expected: 2,
        actual: 1,
        passed: false,
      },
    });
  });

  it("does not send malformed values or consume a session slot", async () => {
    setProcessSessionId("ses_support_assertion");
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const malformed = await sendApplicationAssertion({
      name: "account_email",
      operator: "equals",
      expected: "person@example.com",
      actual: "person@example.com",
      fetch,
    });
    expect(malformed).toEqual({ accepted: false, rejection: "invalid_expected" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an assertion when no session is available", async () => {
    const fetch = vi.fn();
    await expect(
      sendApplicationAssertion({
        name: "item_count",
        operator: "equals",
        expected: 1,
        actual: 1,
        fetch,
      }),
    ).resolves.toEqual({ accepted: false, rejection: "correlation_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
