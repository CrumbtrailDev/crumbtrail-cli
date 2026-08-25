import type { BugEvent } from "crumbtrail-core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKEND_INTAKE_ENDPOINT,
  sendBackendEvent,
  type BackendIntakeWarning,
} from "../backend-intake";

const baseEvent: BugEvent = {
  t: 1_700_000_000_000,
  k: "backend.req.start",
  sessionId: "ses_event",
  d: {
    requestId: "req_123",
    method: "GET",
  },
};

describe("backend intake client", () => {
  it("posts a single backend event to the default local intake shape", async () => {
    const fetch = vi.fn().mockResolvedValue(okJsonResponse());

    await sendBackendEvent({ event: baseEvent, fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${DEFAULT_BACKEND_INTAKE_ENDPOINT}/api/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "ses_event", events: [baseEvent] }),
        signal: undefined,
      },
    );
  });

  it("uses explicit endpoint/session values and includes auth only when configured", async () => {
    const fetch = vi.fn().mockResolvedValue(okJsonResponse());
    const event = { ...baseEvent, sessionId: "ses_event" };

    await sendBackendEvent({
      event,
      sessionId: "ses_option",
      endpoint: " http://localhost:9898/ ",
      authToken: " local-secret-token ",
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:9898/api/events",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Crumbtrail-Auth": "local-secret-token",
        },
        body: JSON.stringify({ sessionId: "ses_option", events: [event] }),
      }),
    );
  });

  it("skips fetch and reports a bounded warning when no usable session exists", async () => {
    const fetch = vi.fn().mockResolvedValue(okJsonResponse());
    const warnings: BackendIntakeWarning[] = [];
    const event: BugEvent = {
      ...baseEvent,
      sessionId: undefined,
      d: { requestId: "req_without_session" },
    };

    await expect(
      sendBackendEvent({
        event,
        fetch,
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBe(false);

    expect(fetch).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      {
        kind: "missing-session",
        message:
          "Backend event was not sent because no session ID was available. " +
          "Nothing correlated it (no x-crumbtrail-session-id header) and this " +
          "process has no capture session of its own. Install autoCapture, or " +
          "check that its session handshake succeeded.",
        requestId: "req_without_session",
        eventKind: "backend.req.start",
      },
    ]);
  });

  it("converts fetch rejections into safe warnings without rejecting", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new Error("network failed with local-secret-token"));
    const warnings: BackendIntakeWarning[] = [];

    await expect(
      sendBackendEvent({
        event: baseEvent,
        authToken: "local-secret-token",
        fetch,
        retries: 0,
        onWarning: warnings.push.bind(warnings),
      }),
    ).resolves.toBe(false);

    expect(warnings).toEqual([
      {
        kind: "fetch-rejected",
        message:
          "Backend events could not reach the capture endpoint; nothing was captured",
        sessionId: "ses_event",
        requestId: "req_123",
        eventKind: "backend.req.start",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
    expect(JSON.stringify(warnings)).not.toContain("network failed");
  });

  it("converts non-2xx responses into status warnings without reading secret response bodies", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("unauthorized local-secret-token"),
    });
    const warnings: BackendIntakeWarning[] = [];

    await sendBackendEvent({
      event: baseEvent,
      authToken: "local-secret-token",
      fetch,
      onWarning: warnings.push.bind(warnings),
    });

    // The refusal body here is not JSON the SDK can attribute to the server, so
    // no reason is appended — and the raw body is never echoed, because a
    // refusal body can carry a secret.
    expect(warnings).toEqual([
      {
        kind: "http-error",
        message:
          "The capture endpoint refused backend events with HTTP 401; nothing from this session will be captured",
        status: 401,
        sessionId: "ses_event",
        requestId: "req_123",
        eventKind: "backend.req.start",
      },
    ]);
    await expect(fetch.mock.results[0].value).resolves.toBeDefined();
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
    const refused = (await fetch.mock.results[0].value) as {
      text: ReturnType<typeof vi.fn>;
    };
    expect(refused.text).not.toHaveBeenCalled();
  });

  it("carries the server's refusal sentence instead of a bare status", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({
        error: "This project API key was not accepted. It may have been revoked.",
        code: "unauthorized",
      }),
    });
    const warnings: BackendIntakeWarning[] = [];

    await sendBackendEvent({
      event: baseEvent,
      authToken: "local-secret-token",
      fetch,
      onWarning: warnings.push.bind(warnings),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "http-error",
      status: 401,
      message:
        "The capture endpoint refused backend events with HTTP 401: This project API key was not accepted. It may have been revoked.; nothing from this session will be captured",
    });
  });

  it("prints the refusal to the default console once when no callback is wired", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({
          error:
            "This project API key was not accepted. It may have been revoked.",
        }),
      });

      // Three events, all refused the same way: one console line, not three.
      await sendBackendEvent({ event: baseEvent, fetch, retries: 0 });
      await sendBackendEvent({ event: baseEvent, fetch, retries: 0 });
      await sendBackendEvent({ event: baseEvent, fetch, retries: 0 });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        "[crumbtrail] The capture endpoint refused backend events with HTTP 401: This project API key was not accepted. It may have been revoked.; nothing from this session will be captured",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a wired onWarning the only surface (no default console duplication)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const warnings: BackendIntakeWarning[] = [];
      const fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: vi.fn().mockResolvedValue({ error: "key not accepted" }),
      });

      await sendBackendEvent({
        event: baseEvent,
        fetch,
        retries: 0,
        onWarning: (w) => warnings.push(w),
      });

      expect(warnings).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("converts malformed JSON response text into a safe warning", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("{not-json local-secret-token"),
    });
    const warnings: BackendIntakeWarning[] = [];

    await sendBackendEvent({
      event: baseEvent,
      authToken: "local-secret-token",
      fetch,
      onWarning: warnings.push.bind(warnings),
    });

    expect(warnings).toEqual([
      {
        kind: "malformed-response",
        message: "Backend intake response was malformed.",
        sessionId: "ses_event",
        requestId: "req_123",
        eventKind: "backend.req.start",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
  });

  it("converts malformed JSON response objects into a safe warning", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi
        .fn()
        .mockResolvedValue({ ok: false, token: "local-secret-token" }),
    });
    const warnings: BackendIntakeWarning[] = [];

    await sendBackendEvent({
      event: baseEvent,
      authToken: "local-secret-token",
      fetch,
      onWarning: warnings.push.bind(warnings),
    });

    expect(warnings).toEqual([
      {
        kind: "malformed-response",
        message: "Backend intake response was malformed.",
        sessionId: "ses_event",
        requestId: "req_123",
        eventKind: "backend.req.start",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
  });

  it("converts response read failures into safe malformed-response warnings", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi
        .fn()
        .mockRejectedValue(new SyntaxError("bad local-secret-token")),
    });
    const warnings: BackendIntakeWarning[] = [];

    await sendBackendEvent({
      event: baseEvent,
      authToken: "local-secret-token",
      fetch,
      onWarning: warnings.push.bind(warnings),
    });

    expect(warnings).toEqual([
      {
        kind: "malformed-response",
        message: "Backend intake response was malformed.",
        sessionId: "ses_event",
        requestId: "req_123",
        eventKind: "backend.req.start",
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("local-secret-token");
  });

  it("retries a transport rejection and reports the event delivered once it lands", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue(okJsonResponse());
    const warnings: BackendIntakeWarning[] = [];

    await expect(
      sendBackendEvent({
        event: baseEvent,
        fetch,
        retryDelayMs: 0,
        sleep: async () => {},
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  it("gives up after the retry budget and reports the event undelivered", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const warnings: BackendIntakeWarning[] = [];

    await expect(
      sendBackendEvent({
        event: baseEvent,
        fetch,
        retries: 2,
        sleep: async () => {},
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(1);
  });

  it("does not retry a response the endpoint actually answered", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: vi.fn() });

    await expect(
      sendBackendEvent({ event: baseEvent, fetch, sleep: async () => {} }),
    ).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("swallows warning callback failures to keep host responses safe", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network failed"));

    await expect(
      sendBackendEvent({
        event: baseEvent,
        fetch,
        retries: 0,
        onWarning: () => {
          throw new Error("warning callback failed");
        },
      }),
    ).resolves.toBe(false);
  });
});

function okJsonResponse() {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('{"ok":true}'),
  };
}
