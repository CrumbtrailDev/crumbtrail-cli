import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_APPLICATION_ASSERTIONS_PER_SESSION } from "crumbtrail-core";
import { clearProcessSessionId, setProcessSessionId } from "../process-session";
import {
  clearApplicationAssertionSession,
  endApplicationAssertionSession,
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
      events: Array<{
        k: string;
        sessionId?: string;
        d: Record<string, unknown>;
      }>;
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
      name: "order_status",
      operator: "equals",
      expected: "person@example.com",
      actual: "person@example.com",
      fetch,
    });
    expect(malformed).toEqual({
      accepted: false,
      rejection: "invalid_expected",
    });
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

  it("retains a capped session after bounded admission fills with other IDs", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const assertion = (sessionId: string) =>
      sendApplicationAssertion({
        name: "item_count",
        operator: "equals",
        expected: 1,
        actual: 1,
        sessionId,
        endpoint: "https://capture.example",
        fetch,
      });

    for (let i = 0; i < MAX_APPLICATION_ASSERTIONS_PER_SESSION; i += 1)
      await assertion("ses_capped");

    const otherResults: Array<Awaited<ReturnType<typeof assertion>>> = [];
    for (let i = 0; i < 1_000; i += 1)
      otherResults.push(await assertion(`ses_other_${i}`));

    expect(otherResults.filter((result) => result.accepted)).toHaveLength(999);
    expect(otherResults.at(-1)).toEqual({
      accepted: false,
      rejection: "session_tracking_limit_reached",
    });
    expect(await assertion("ses_capped")).toEqual({
      accepted: false,
      rejection: "session_cap_reached",
    });

    endApplicationAssertionSession("ses_other_0");
    expect((await assertion("ses_after_cleanup")).accepted).toBe(true);

    clearApplicationAssertionSession("ses_capped");
    expect((await assertion("ses_capped")).accepted).toBe(true);
  });

  it("does not throw, reread, or leak hostile assertion options", async () => {
    setProcessSessionId("ses_hostile_options");
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(await sendApplicationAssertion(null as never)).toEqual({
      accepted: false,
      rejection: "invalid_options",
    });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(await sendApplicationAssertion(revoked.proxy as never)).toEqual({
      accepted: false,
      rejection: "invalid_options",
    });

    let expectedReads = 0;
    const options = {
      name: "order_status",
      operator: "equals" as const,
      get expected() {
        expectedReads += 1;
        return expectedReads === 1 ? "ready" : "sk_live_leaked";
      },
      actual: "ready",
      endpoint: "https://capture.example",
      fetch,
    };
    const result = await sendApplicationAssertion(options);
    expect(result.accepted).toBe(true);
    expect(expectedReads).toBe(1);
    expect(fetch.mock.calls[0]![1].body).toContain('"expected":"ready"');
    expect(fetch.mock.calls[0]![1].body).not.toContain("sk_live_leaked");
  });

  it("rejects hostile transport values without sending or throwing", async () => {
    setProcessSessionId("ses_hostile_transport");
    const fetch = vi.fn();
    for (const key of [
      "endpoint",
      "authToken",
      "fetch",
      "onWarning",
      "sleep",
    ]) {
      const result = await sendApplicationAssertion({
        name: "order_status",
        operator: "equals",
        expected: "ready",
        actual: "ready",
        [key]: key === "fetch" ? "not-a-function" : {},
      } as never);
      expect(result).toEqual({
        accepted: false,
        rejection: "invalid_options",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
