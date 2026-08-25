import { EventEmitter } from "node:events";
import type { BugEvent } from "crumbtrail-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushBackendEvents,
  resetBackendIntakeQueueForTest,
} from "../backend-intake";
import { buildBackendRequestStartEvent } from "../backend-events";
import {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
  type CrumbtrailExpressResponse,
} from "../express";
import {
  clearProcessSessionId,
  getProcessSessionId,
  setProcessSessionId,
} from "../process-session";

/**
 * S7-2: a wizard-wired Express API with no browser in front of it recorded
 * nothing but the route-less crash event, because the middleware took its
 * session only from `x-crumbtrail-session-id` and the intake refuses an event
 * with no session. These tests pin the fallback and, just as importantly, that
 * a browser-correlated request is untouched by it.
 */

const PROCESS_SESSION = "auto_process_1";
const BROWSER_SESSION = "sess_browser_1";

class FakeResponse extends EventEmitter implements CrumbtrailExpressResponse {
  statusCode?: number;
  writableEnded?: boolean;

  constructor(statusCode?: number, writableEnded?: boolean) {
    super();
    this.statusCode = statusCode;
    this.writableEnded = writableEnded;
  }
}

beforeEach(() => {
  resetBackendIntakeQueueForTest();
  clearProcessSessionId();
});

afterEach(() => clearProcessSessionId());

describe("process session registry", () => {
  it("registers, reads back and withdraws a session", () => {
    expect(getProcessSessionId()).toBeUndefined();
    setProcessSessionId(PROCESS_SESSION);
    expect(getProcessSessionId()).toBe(PROCESS_SESSION);
    clearProcessSessionId(PROCESS_SESSION);
    expect(getProcessSessionId()).toBeUndefined();
  });

  it("ignores a blank id and refuses to clear someone else's", () => {
    setProcessSessionId("   ");
    expect(getProcessSessionId()).toBeUndefined();
    setProcessSessionId(PROCESS_SESSION);
    clearProcessSessionId("some_other_session");
    expect(getProcessSessionId()).toBe(PROCESS_SESSION);
  });
});

describe("backend request correlation with a process session", () => {
  it("uses the process session only when nothing correlated the request", () => {
    const event = buildBackendRequestStartEvent({
      method: "GET",
      url: "/api/orders/12345",
      processSessionId: PROCESS_SESSION,
      now: 1_000,
    });
    expect(event.sessionId).toBe(PROCESS_SESSION);
    expect(event.d.correlation).toMatchObject({
      status: "process-session",
      sessionIdSource: "process",
    });
  });

  it("keeps the browser's session when the request carries one", () => {
    const event = buildBackendRequestStartEvent({
      method: "GET",
      url: "/api/orders/12345",
      headers: {
        "x-crumbtrail-session-id": BROWSER_SESSION,
        "x-crumbtrail-request-id": "req_1",
      },
      processSessionId: PROCESS_SESSION,
      now: 1_000,
    });
    expect(event.sessionId).toBe(BROWSER_SESSION);
    expect(event.d.correlation).toMatchObject({
      status: "linked",
      sessionIdSource: "header",
    });
  });

  it("keeps an explicit option session ahead of the process session", () => {
    const event = buildBackendRequestStartEvent({
      method: "GET",
      url: "/api/orders/12345",
      sessionId: "sess_option",
      processSessionId: PROCESS_SESSION,
      now: 1_000,
    });
    expect(event.sessionId).toBe("sess_option");
    expect(event.d.correlation).toMatchObject({ sessionIdSource: "option" });
  });

  it("still reports a stripped-header correlation gap under the fallback", () => {
    const emitted: BugEvent[] = [];
    const event = buildBackendRequestStartEvent({
      method: "GET",
      url: "/api/orders/12345",
      headers: {
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      processSessionId: PROCESS_SESSION,
      emit: (gap) => emitted.push(gap),
      now: 1_000,
    });
    // The event lands, and the gap still says the session header was missing:
    // a filed request must not read as a browser join that happened.
    expect(event.sessionId).toBe(PROCESS_SESSION);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].d.reason).toBe("header_stripped");
  });

  it("emits no session at all when there is no process session either", () => {
    const event = buildBackendRequestStartEvent({
      method: "GET",
      url: "/healthz",
      now: 1_000,
    });
    expect(event.sessionId).toBeUndefined();
    expect(event.d.correlation).toMatchObject({
      sessionIdSource: "missing",
    });
  });
});

describe("express middleware with no browser", () => {
  it("sends start and end into the process session, with the route", async () => {
    setProcessSessionId(PROCESS_SESSION);
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = {
      method: "GET",
      originalUrl: "/api/orders/12345",
      route: { path: "/api/orders/:id" },
      headers: {} as Record<string, string>,
    };
    const res = new FakeResponse(500);

    const middleware = createCrumbtrailExpressMiddleware({
      fetch,
      captureLogs: false,
      captureRuntimeWarnings: false,
    });
    middleware(req, res, () => {});
    res.emit("finish");
    await settle();

    const events = sentEvents(fetch);
    const start = events.find((e) => e.k.endsWith("req.start"));
    const end = events.find((e) => e.k.endsWith("req.end"));
    expect(start?.sessionId).toBe(PROCESS_SESSION);
    expect(end?.sessionId).toBe(PROCESS_SESSION);
    expect(end?.d.route).toBe("/api/orders/:id");
    expect(end?.d.statusCode).toBe(500);
    // The terminal event resolves the same fallback rather than presenting it
    // as an explicit option, so nothing downstream reads it as a join.
    expect(end?.d.correlation).toMatchObject({
      status: "process-session",
      sessionIdSource: "process",
    });
    expect(end?.d.requestId).toBe(start?.d.requestId);
  });

  it("records the handler's thrown error against the process session", async () => {
    setProcessSessionId(PROCESS_SESSION);
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = {
      method: "GET",
      originalUrl: "/api/orders/12345",
      route: { path: "/api/orders/:id" },
      headers: {} as Record<string, string>,
    };
    const res = new FakeResponse(500);

    const errorMiddleware = createCrumbtrailExpressErrorMiddleware({ fetch });
    errorMiddleware(new Error("orders lookup failed"), req, res, () => {});
    await settle();

    const errorEvent = sentEvents(fetch).find((e) => e.k.endsWith("req.error"));
    expect(errorEvent?.sessionId).toBe(PROCESS_SESSION);
    expect(errorEvent?.d.route).toBe("/api/orders/:id");
  });

  it("does not attribute captured log lines to the process session", async () => {
    // `autoCapture` already records logs and runtime warnings into the process
    // session itself; attributing them here as well would report each line twice.
    setProcessSessionId(PROCESS_SESSION);
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const emitted: BugEvent[] = [];
    const middleware = createCrumbtrailExpressMiddleware({
      fetch,
      captureRuntimeWarnings: false,
      logStreams: {
        stdout: {
          write: (chunk: string) => {
            emitted.push({ t: 0, k: "noop", d: { chunk } });
            return true;
          },
        } as never,
      },
    });
    const req = {
      method: "GET",
      originalUrl: "/api/orders/12345",
      headers: {} as Record<string, string>,
    };
    const res = new FakeResponse(500);
    middleware(req, res, () => {});
    res.emit("finish");
    await settle();

    middleware.crumbtrailLogCapture?.stop();
    // Only the request pair was sent; no `backend.log` rode the fallback.
    expect(
      sentEvents(fetch).filter((event) => event.k === "backend.log"),
    ).toHaveLength(0);
  });

  it("sends nothing when no process session has been established", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = {
      method: "GET",
      originalUrl: "/healthz",
      headers: {} as Record<string, string>,
    };
    const res = new FakeResponse(200);

    const middleware = createCrumbtrailExpressMiddleware({
      fetch,
      captureLogs: false,
      captureRuntimeWarnings: false,
    });
    middleware(req, res, () => {});
    res.emit("finish");
    await settle();

    expect(fetch).not.toHaveBeenCalled();
  });
});

function okResponse() {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue('{"ok":true}'),
  };
}

function sentEvents(fetch: ReturnType<typeof vi.fn>): BugEvent[] {
  return fetch.mock.calls.flatMap((call) => {
    const body = JSON.parse(String(call[1]?.body)) as { events?: BugEvent[] };
    return body.events ?? [];
  });
}

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await flushBackendEvents();
  }
}
