import type { BugEvent } from "crumbtrail-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backendIntakeQueueStats,
  flushBackendEvents,
  resetBackendIntakeQueueForTest,
  sendBackendEvent,
  type BackendIntakeWarning,
} from "../backend-intake";

function event(n: number): BugEvent {
  return {
    t: 1_000 + n,
    k: "backend.req.end",
    d: { requestId: `req-${n}`, statusCode: 200 },
  } as unknown as BugEvent;
}

function ok() {
  return { ok: true, status: 200, text: async () => '{"ok":true}' };
}

/** Counts events across however many POSTs the queue chose to make. */
function eventsSent(fetch: ReturnType<typeof vi.fn>): number {
  return fetch.mock.calls.reduce((total, call) => {
    const body = JSON.parse(String((call[1] as { body?: string })?.body));
    return total + (body.events?.length ?? 0);
  }, 0);
}

const base = { sessionId: "ses_q", endpoint: "http://intake.test" };

beforeEach(() => resetBackendIntakeQueueForTest());

describe("intake delivery under normal load", () => {
  it("posts a single event immediately and on its own", async () => {
    const fetch = vi.fn().mockResolvedValue(ok());
    await sendBackendEvent({ ...base, event: event(1), fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body).toEqual({ sessionId: "ses_q", events: [event(1)] });
    expect(backendIntakeQueueStats()).toEqual({
      queued: 0,
      inFlight: 0,
      dropped: 0,
    });
  });

  it("does not batch when sends are sequential", async () => {
    const fetch = vi.fn().mockResolvedValue(ok());
    for (let n = 0; n < 5; n += 1)
      await sendBackendEvent({ ...base, event: event(n), fetch });

    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe("intake delivery under burst", () => {
  it("keeps every event when a burst far exceeds the concurrency limit", async () => {
    const fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 5)),
    );
    const burst = Array.from({ length: 300 }, (_, n) =>
      sendBackendEvent({ ...base, event: event(n), fetch }),
    );

    // The host application is never made to wait on any of this.
    expect(backendIntakeQueueStats().inFlight).toBeLessThanOrEqual(4);

    await Promise.all(burst);

    expect(eventsSent(fetch)).toBe(300);
    expect(fetch.mock.calls.length).toBeLessThan(300);
    expect(backendIntakeQueueStats().dropped).toBe(0);
  });

  it("never opens more than the concurrency limit at once", async () => {
    let concurrent = 0;
    let peak = 0;
    const fetch = vi.fn().mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 3));
      concurrent -= 1;
      return ok();
    });

    await Promise.all(
      Array.from({ length: 120 }, (_, n) =>
        sendBackendEvent({ ...base, event: event(n), fetch }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(eventsSent(fetch)).toBe(120);
  });

  it("keeps sessions apart when several are capturing at once", async () => {
    const fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 5)),
    );
    await Promise.all(
      Array.from({ length: 60 }, (_, n) =>
        sendBackendEvent({
          ...base,
          sessionId: `ses_${n % 3}`,
          event: event(n),
          fetch,
        }),
      ),
    );

    for (const call of fetch.mock.calls) {
      const body = JSON.parse(String(call[1].body));
      expect(typeof body.sessionId).toBe("string");
      // One envelope carries one session id, so a batch may never mix them.
      expect(body.events.length).toBeGreaterThan(0);
    }
    expect(eventsSent(fetch)).toBe(60);
  });
});

describe("retry policy", () => {
  it("retries a transport rejection and succeeds without reporting", async () => {
    const warnings: BackendIntakeWarning[] = [];
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        }),
      )
      .mockResolvedValue(ok());

    await sendBackendEvent({
      ...base,
      event: event(1),
      fetch,
      onWarning: (w) => warnings.push(w),
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  // A status means the intake received the payload and judged it. Repeating the
  // identical body cannot change that verdict, so no status is retried; only a
  // transport rejection, where nothing was judged because nothing arrived, is.
  it("does not repeat a request the intake actually answered", async () => {
    const attempts = async (status: number) => {
      resetBackendIntakeQueueForTest();
      const fetch = vi.fn().mockResolvedValue({ ok: false, status });
      await sendBackendEvent({ ...base, event: event(1), fetch });
      return fetch.mock.calls.length;
    };

    for (const status of [400, 401, 404, 429, 500, 503]) {
      expect({ status, calls: await attempts(status) }).toEqual({
        status,
        calls: 1,
      });
    }
  });

  it("reports the transport cause instead of a bare TypeError", async () => {
    const warnings: BackendIntakeWarning[] = [];
    const fetch = vi.fn().mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_SOCKET" },
      }),
    );

    await sendBackendEvent({
      ...base,
      event: event(1),
      fetch,
      onWarning: (w) => warnings.push(w),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "fetch-rejected",
      cause: "UND_ERR_SOCKET",
      attempts: 3,
    });
  });

  it("does not retry an abort", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
    await sendBackendEvent({ ...base, event: event(1), fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the queue is bounded", () => {
  it("discards the newest events and says so rather than growing without limit", async () => {
    const warnings: BackendIntakeWarning[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn().mockImplementation(async () => {
      await blocked;
      return ok();
    });

    const sends = Array.from({ length: 1_400 }, (_, n) =>
      sendBackendEvent({
        ...base,
        event: event(n),
        fetch,
        onWarning: (w) => warnings.push(w),
      }),
    );

    const stats = backendIntakeQueueStats();
    expect(stats.queued).toBeLessThanOrEqual(1_000);
    expect(stats.dropped).toBeGreaterThan(0);
    expect(warnings.some((w) => w.kind === "queue-overflow")).toBe(true);
    // A drop storm is reported, not narrated once per event.
    expect(warnings.filter((w) => w.kind === "queue-overflow").length).toBeLessThan(
      stats.dropped,
    );

    release?.();
    await Promise.all(sends);
  });
});

describe("flush", () => {
  it("resolves only once the queue has drained", async () => {
    const fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 5)),
    );
    for (let n = 0; n < 50; n += 1)
      void sendBackendEvent({ ...base, event: event(n), fetch });

    await flushBackendEvents();

    expect(backendIntakeQueueStats()).toMatchObject({ queued: 0, inFlight: 0 });
    expect(eventsSent(fetch)).toBe(50);
  });

  it("returns immediately when nothing is pending", async () => {
    await expect(flushBackendEvents()).resolves.toBeUndefined();
  });
});
