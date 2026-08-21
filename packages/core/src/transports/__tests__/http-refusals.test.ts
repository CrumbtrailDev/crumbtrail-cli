/**
 * The transport's refusal behaviour, end to end against a recording `fetch`.
 *
 * `test-fixtures/wire-contract/transport.json` says a non-2xx "is not a
 * delivery" and that three outcomes must be distinguished. Until these tests
 * existed only `sendEvents` and `sendBlob` obeyed it: session start, session
 * end and the bug report all awaited a `fetch` and inspected nothing, so a
 * refused start produced a session that reported itself healthy for its whole
 * lifetime while nothing landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BugReportDeliveryError,
  CaptureShedError,
  EventDeliveryError,
  HttpTransport,
  SessionDeliveryError,
} from "../http";
import type { BugEvent, BugReport } from "../../types";

const ENDPOINT = "http://localhost:9898";

function makeReport(): BugReport {
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
  };
}

function ok(): Response {
  return new Response('{"ok":true}');
}

/** `fetch` that answers `ok()` unless the path matches an override. */
function routed(overrides: Record<string, () => Response>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    for (const [fragment, make] of Object.entries(overrides)) {
      if (url.includes(fragment)) return make();
    }
    return ok();
  });
}

let warn: { mock: { calls: unknown[][] } };

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as {
    mock: { calls: unknown[][] };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startSession", () => {
  for (const status of [401, 402, 409, 429]) {
    it(`throws when the server answers ${status}`, async () => {
      vi.stubGlobal("fetch", routed({ "/api/session/start": () => new Response("no", { status }) }));
      const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

      const error = await transport
        .startSession("ses_test", {})
        .catch((caught) => caught as SessionDeliveryError);

      expect(error).toBeInstanceOf(SessionDeliveryError);
      expect((error as SessionDeliveryError).status).toBe(status);
      expect((error as SessionDeliveryError).phase).toBe("start");
    });
  }

  it("names the refusal on the console exactly once", async () => {
    vi.stubGlobal("fetch", routed({ "/api/session/start": () => new Response("no", { status: 402 }) }));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

    await transport.startSession("ses_test", {}).catch(() => {});
    await transport.startSession("ses_test", {}).catch(() => {});

    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.filter((l: string) => l.includes("402"))).toHaveLength(1);
    expect(lines[0]).toContain("nothing from this session will be captured");
  });

  it("refuses later batches locally instead of posting them into a 404", async () => {
    const fetchMock = routed({ "/api/session/start": () => new Response("no", { status: 402 }) });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {}).catch(() => {});
    fetchMock.mockClear();

    const error = await transport
      .sendEvents([{ t: 1, k: "err", d: {} }])
      .catch((caught) => caught as EventDeliveryError);

    expect(error).toBeInstanceOf(EventDeliveryError);
    expect((error as EventDeliveryError).status).toBe(402);
    // No session row exists, so the POST could only ever be a 404 the caller
    // would then try to report through the same dead route.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers once a later start succeeds", async () => {
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/session/start") && first) {
          first = false;
          return new Response("no", { status: 429 });
        }
        return ok();
      }),
    );
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

    await transport.startSession("ses_test", {}).catch(() => {});
    await transport.startSession("ses_test", {});

    await expect(
      transport.sendEvents([{ t: 1, k: "err", d: {} }]),
    ).resolves.toBeUndefined();
  });

  it("still resolves on a 2xx", async () => {
    vi.stubGlobal("fetch", routed({}));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await expect(transport.startSession("ses_test", {})).resolves.toBeUndefined();
  });
});

describe("sendBugReport", () => {
  for (const status of [401, 413, 429, 404]) {
    it(`throws when the flag is refused with ${status}`, async () => {
      vi.stubGlobal("fetch", routed({ "/api/bug/flag": () => new Response("no", { status }) }));
      const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

      const error = await transport
        .sendBugReport(makeReport(), [])
        .catch((caught) => caught as BugReportDeliveryError);

      expect(error).toBeInstanceOf(BugReportDeliveryError);
      expect((error as BugReportDeliveryError).status).toBe(status);
      expect((error as BugReportDeliveryError).part).toBe("report");
    });
  }

  it("throws when the voice upload 404s, which is what hosted mode does today", async () => {
    vi.stubGlobal("fetch", routed({ "/voice": () => new Response("not found", { status: 404 }) }));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

    const error = await transport
      .sendBugReport(makeReport(), [], new Blob(["audio"]))
      .catch((caught) => caught as BugReportDeliveryError);

    expect(error).toBeInstanceOf(BugReportDeliveryError);
    expect((error as BugReportDeliveryError).part).toBe("voice");
    expect((error as BugReportDeliveryError).status).toBe(404);
  });

  it("does not attempt the voice upload when the flag itself was refused", async () => {
    const fetchMock = routed({ "/api/bug/flag": () => new Response("no", { status: 413 }) });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });

    await transport
      .sendBugReport(makeReport(), [], new Blob(["audio"]))
      .catch(() => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("endSession", () => {
  it("warns on a refusal but never throws into the host's teardown", async () => {
    vi.stubGlobal("fetch", routed({ "/api/session/end": () => new Response("no", { status: 409 }) }));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    await expect(transport.endSession("ses_test")).resolves.toBeUndefined();
    expect(
      warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n"),
    ).toContain("409");
  });
});

describe("the sendBeacon unload path cannot carry the ingest key", () => {
  function offline(): void {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unloading")));
  }

  it("reports the loss rather than posting the final batch unauthenticated", async () => {
    vi.stubGlobal("fetch", routed({}));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });
    offline();

    const error = await transport
      .sendEvents([{ t: 1, k: "err", d: { msg: "the failure that made them leave" } }])
      .catch((caught) => caught as EventDeliveryError);

    expect(error).toBeInstanceOf(EventDeliveryError);
    expect((error as EventDeliveryError).status).toBe(0);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("still beacons for an unauthenticated endpoint, where it is a real delivery path", async () => {
    vi.stubGlobal("fetch", routed({}));
    const transport = new HttpTransport(ENDPOINT);
    await transport.startSession("ses_test", {});

    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      writable: true,
      configurable: true,
    });
    offline();

    await expect(
      transport.sendEvents([{ t: 1, k: "err", d: {} }]),
    ).resolves.toBeUndefined();
    expect(sendBeacon).toHaveBeenCalledOnce();
  });
});

describe("byte aware batching", () => {
  /** n events whose serialized body clearly crosses the 1 MiB ingest cap. */
  function fatBatch(n: number): BugEvent[] {
    return Array.from({ length: n }, (_, i) => ({
      t: 1000 + i,
      k: "net.res",
      d: { id: i, st: 200, body: "x".repeat(200_000) },
    }));
  }

  it("splits an oversized batch before the first POST", async () => {
    const fetchMock = routed({});
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});
    fetchMock.mockClear();

    await transport.sendEvents(fatBatch(10));

    const bodies = fetchMock.mock.calls.map((c) =>
      String((c[1] as RequestInit).body),
    );
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
        1_048_576,
      );
    }
    // Every event still went out; splitting is not dropping.
    const sent = bodies.flatMap(
      (b) => (JSON.parse(b) as { events: BugEvent[] }).events,
    );
    expect(sent).toHaveLength(10);
  });

  it("keeps a batch that fits as a single request", async () => {
    const fetchMock = routed({});
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});
    fetchMock.mockClear();

    await transport.sendEvents([
      { t: 1, k: "con", d: { lv: "log", args: [] } },
      { t: 2, k: "con", d: { lv: "log", args: [] } },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bisects on a 413 instead of dropping the batch whole", async () => {
    // Refuses any batch of more than two events, accepts the rest — the shape
    // of a server whose cap the client guessed wrong.
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (!url.includes("/api/events")) return ok();
      const { events } = JSON.parse(String(init.body)) as { events: BugEvent[] };
      return events.length > 2 ? new Response("too large", { status: 413 }) : ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});
    fetchMock.mockClear();

    const events: BugEvent[] = Array.from({ length: 8 }, (_, i) => ({
      t: i,
      k: "con",
      d: { i },
    }));
    await expect(transport.sendEvents(events)).resolves.toBeUndefined();

    const delivered = fetchMock.mock.calls.map(
      (c) => JSON.parse(String((c[1] as RequestInit).body)) as { events: BugEvent[] },
    );
    const accepted = delivered
      .filter((b) => b.events.length <= 2)
      .flatMap((b) => b.events);
    expect(accepted).toHaveLength(8);
  });

  it("reports a single event the server will never accept", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ "/api/events": () => new Response("too large", { status: 413 }) }),
    );
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    const error = await transport
      .sendEvents([{ t: 1, k: "con", d: {} }])
      .catch((caught) => caught as EventDeliveryError);

    expect(error).toBeInstanceOf(EventDeliveryError);
    expect((error as EventDeliveryError).status).toBe(413);
    expect((error as EventDeliveryError).eventCount).toBe(1);
  });
});

describe("202 capture shed", () => {
  function shedResponse(): Response {
    return new Response(
      JSON.stringify({
        ok: true,
        capture: "shed",
        reason: "bytes_per_day",
        retryAfterSeconds: 60,
      }),
      { status: 202, headers: { "Retry-After": "60" } },
    );
  }

  it("is a refusal, not a delivery", async () => {
    vi.stubGlobal("fetch", routed({ "/api/events": shedResponse }));
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    const error = await transport
      .sendEvents([{ t: 1, k: "con", d: {} }])
      .catch((caught) => caught as CaptureShedError);

    expect(error).toBeInstanceOf(CaptureShedError);
    expect((error as CaptureShedError).reason).toBe("bytes_per_day");
    expect((error as CaptureShedError).retryAfterSeconds).toBe(60);
    expect((error as CaptureShedError).status).toBe(202);
  });

  it("honours Retry-After by not sending again while the shed holds", async () => {
    const fetchMock = routed({ "/api/events": shedResponse });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    await transport.sendEvents([{ t: 1, k: "con", d: {} }]).catch(() => {});
    fetchMock.mockClear();

    await expect(
      transport.sendEvents([{ t: 2, k: "con", d: {} }]),
    ).rejects.toBeInstanceOf(CaptureShedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes once the shed window has passed", async () => {
    vi.useFakeTimers();
    try {
      let shedOnce = true;
      const fetchMock = vi.fn(async (url: string) => {
        if (!url.includes("/api/events")) return ok();
        return shedOnce ? shedResponse() : ok();
      });
      vi.stubGlobal("fetch", fetchMock);
      const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
      await transport.startSession("ses_test", {});
      await transport.sendEvents([{ t: 1, k: "con", d: {} }]).catch(() => {});

      shedOnce = false;
      vi.advanceTimersByTime(61_000);

      await expect(
        transport.sendEvents([{ t: 2, k: "con", d: {} }]),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an ordinary 202 as a delivery", async () => {
    vi.stubGlobal(
      "fetch",
      routed({ "/api/events": () => new Response('{"ok":true}', { status: 202 }) }),
    );
    const transport = new HttpTransport(ENDPOINT, { authToken: "ctkey_x" });
    await transport.startSession("ses_test", {});

    await expect(
      transport.sendEvents([{ t: 1, k: "con", d: {} }]),
    ).resolves.toBeUndefined();
  });
});
