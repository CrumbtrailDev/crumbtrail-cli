import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpTransport } from "../http";
import type { BugReport } from "../../types";

function makeReport(overrides?: Partial<BugReport>): BugReport {
  return {
    bugId: "bug_1",
    sessionId: "ses_test",
    flaggedAt: 1000,
    windowMs: 5000,
    url: "https://example.dev/page",
    userAgent: "test-agent",
    summary: {
      errorCount: 0,
      failedRequestCount: 0,
      eventCount: 1,
      eventKinds: { con: 1 },
      durationMs: 5000,
    },
    ...overrides,
  };
}

describe("HttpTransport", () => {
  const endpoint = "http://localhost:9898";
  let transport: HttpTransport;

  beforeEach(() => {
    transport = new HttpTransport(endpoint, { authToken: "test-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends startSession request", async () => {
    await transport.startSession("ses_test", { app: "myapp" });

    expect(fetch).toHaveBeenCalledWith(`${endpoint}/api/session/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crumbtrail-Auth": "test-token",
      },
      body: JSON.stringify({
        sessionId: "ses_test",
        metadata: { app: "myapp" },
      }),
    });
  });

  it("sends events with session ID", async () => {
    await transport.startSession("ses_test", {});
    const events = [{ t: 1000, k: "con", d: { lv: "log", args: ['"hi"'] } }];
    await transport.sendEvents(events);

    expect(fetch).toHaveBeenCalledWith(`${endpoint}/api/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crumbtrail-Auth": "test-token",
      },
      body: JSON.stringify({ sessionId: "ses_test", events }),
      keepalive: true,
    });
  });

  it("marks small event batches keepalive so they survive page teardown", async () => {
    await transport.startSession("ses_test", {});
    await transport.sendEvents([{ t: 1000, k: "err", d: { msg: "boom" } }]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      c[0].endsWith("/api/events"),
    )!;
    expect(call[1].keepalive).toBe(true);
  });

  it("does not request keepalive for batches over the keepalive body budget", async () => {
    await transport.startSession("ses_test", {});
    // Single event whose serialized body clearly exceeds the 60 KB budget.
    await transport.sendEvents([
      { t: 1000, k: "dom.snap", d: { html: "x".repeat(70_000) } },
    ]);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      c[0].endsWith("/api/events"),
    )!;
    expect(call[1].keepalive).toBeUndefined();
  });

  it("falls back to sendBeacon on sendEvents fetch failure", async () => {
    await transport.startSession("ses_test", {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });

    const events = [{ t: 1000, k: "err", d: { msg: "boom" } }];
    await transport.sendEvents(events);

    expect(sendBeacon).toHaveBeenCalledWith(
      `${endpoint}/api/events`,
      expect.any(Blob),
    );
    // The beacon body carries the session id, matching the fetch payload.
    const beaconBody = await (sendBeacon.mock.calls[0][1] as Blob).text();
    expect(JSON.parse(beaconBody)).toEqual({
      sessionId: "ses_test",
      events,
    });
  });

  it("does not throw when sendEvents fetch fails and sendBeacon is unavailable", async () => {
    await transport.startSession("ses_test", {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    await expect(
      transport.sendEvents([{ t: 1000, k: "err", d: {} }]),
    ).resolves.toBeUndefined();
  });

  it("sends endSession request", async () => {
    await transport.startSession("ses_test", {});
    await transport.endSession("ses_test");

    expect(fetch).toHaveBeenCalledWith(`${endpoint}/api/session/end`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crumbtrail-Auth": "test-token",
      },
      body: JSON.stringify({ sessionId: "ses_test" }),
    });
  });

  it("sends blob with session ID header", async () => {
    await transport.startSession("ses_test", {});
    const blob = new Blob(["binary data"], { type: "video/webm" });
    await transport.sendBlob("recording.webm", blob, { duration: 3600 });

    expect(fetch).toHaveBeenCalledWith(
      `${endpoint}/api/blob/recording.webm`,
      expect.objectContaining({
        method: "POST",
        body: blob,
      }),
    );
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      c[0].includes("/api/blob/"),
    )!;
    expect(call[1].headers["X-Session-Id"]).toBe("ses_test");
    expect(call[1].headers["X-Metadata"]).toBe(
      JSON.stringify({ duration: 3600 }),
    );
    expect(call[1].headers["X-Crumbtrail-Auth"]).toBe("test-token");
  });

  it("sends a bug report without a voice blob using a single request", async () => {
    const report = makeReport();
    const events = [{ t: 1000, k: "con", d: { lv: "log", args: ['"hi"'] } }];
    await transport.sendBugReport(report, events);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`${endpoint}/api/bug/flag`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crumbtrail-Auth": "test-token",
      },
      body: JSON.stringify({ report, events }),
    });
  });

  it("sends a follow-up voice upload request when a voice blob is provided", async () => {
    const report = makeReport({ bugId: "bug_voice" });
    const voiceBlob = new Blob(["audio bytes"], { type: "audio/webm" });
    await transport.sendBugReport(report, [], voiceBlob);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `${endpoint}/api/bug/flag`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${endpoint}/api/bug/bug_voice/voice`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Crumbtrail-Auth": "test-token",
        },
        body: voiceBlob,
      },
    );
  });

  it("omits the auth header entirely when no authToken is configured", async () => {
    const anonTransport = new HttpTransport(endpoint);
    await anonTransport.startSession("ses_anon", {});

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers).toEqual({ "Content-Type": "application/json" });
    expect(call[1].headers).not.toHaveProperty("X-Crumbtrail-Auth");
  });

  it("falls back to sendBeacon on endSession fetch failure", async () => {
    await transport.startSession("ses_test", {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });

    await transport.endSession("ses_test");

    expect(sendBeacon).toHaveBeenCalledWith(
      `${endpoint}/api/session/end`,
      expect.any(Blob),
    );
  });

  it("does not throw when endSession fetch fails and sendBeacon is unavailable", async () => {
    await transport.startSession("ses_test", {});

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    await expect(transport.endSession("ses_test")).resolves.toBeUndefined();
  });
});
