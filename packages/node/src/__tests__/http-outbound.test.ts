import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { installOutboundHttpCapture } from "../http-server";
import { setProcessSessionId, clearProcessSessionId } from "../process-session";
import { runInBackendRequestContext } from "../request-context";

/**
 * Outbound capture is the lane that names an infrastructure failure. These
 * tests hold it to the two things that make it usable: it records the call that
 * failed with a cause a reader can act on, and it never changes what the host's
 * own call does.
 */

/** A stand-in for the `ClientRequest` `http.request` returns. */
function fakeClientRequest(): EventEmitter {
  return new EventEmitter();
}

function fakeHttpModule(): {
  mod: Record<string, unknown>;
  requests: EventEmitter[];
  args: unknown[][];
} {
  const requests: EventEmitter[] = [];
  const args: unknown[][] = [];
  const mod: Record<string, unknown> = {
    request: (...values: unknown[]) => {
      args.push(values);
      const request = fakeClientRequest();
      requests.push(request);
      return request;
    },
    get: (...values: unknown[]) => {
      args.push(values);
      const request = fakeClientRequest();
      requests.push(request);
      return request;
    },
  };
  return { mod, requests, args };
}

function withProcessSession<T>(sessionId: string, run: () => T): T {
  setProcessSessionId(sessionId);
  try {
    return run();
  } finally {
    clearProcessSessionId(sessionId);
  }
}

describe("installOutboundHttpCapture", () => {
  it("records an upstream call that answered, with the redacted URL", () => {
    const events: BugEvent[] = [];
    const { mod, requests } = fakeHttpModule();
    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      httpImpl: mod,
      httpsImpl: {},
      fetchHost: {},
      now: (() => {
        let value = 1_000;
        return () => (value += 25);
      })(),
    });

    withProcessSession("s_out", () => {
      (mod.request as (...a: unknown[]) => unknown)(
        "http://pricing.internal/quote?token=abc123secret",
        { method: "POST" },
      );
      requests[0].emit("response", { statusCode: 200 });
    });
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("backend.http");
    expect(events[0].d.method).toBe("POST");
    expect(events[0].d.status).toBe(200);
    expect(events[0].d.durationMs).toBeGreaterThanOrEqual(0);
    // The dependency names itself, which is what the service-aware detectors
    // join on.
    expect(events[0].d.service).toBe("pricing");
    // The query string carried a credential and must not have survived.
    expect(String(events[0].d.url)).not.toContain("abc123secret");
  });

  it("classifies a DNS failure as such rather than as a generic error", () => {
    const events: BugEvent[] = [];
    const { mod, requests } = fakeHttpModule();
    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      httpImpl: mod,
      httpsImpl: {},
      fetchHost: {},
    });

    withProcessSession("s_dns", () => {
      (mod.request as (...a: unknown[]) => unknown)("http://cache.internal/v1");
      const failure = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "ENOTFOUND",
      });
      // Nothing listens for `error` here, and capture must not have changed
      // that: an unlistened `error` still throws, exactly as it would have
      // without instrumentation. A listener added by capture would have
      // swallowed it and kept alive a process Node was going to end.
      expect(requests[0].listenerCount("error")).toBe(0);
      expect(() => requests[0].emit("error", failure)).toThrow(
        "getaddrinfo ENOTFOUND",
      );
    });
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].d.errorKind).toBe("dns");
    expect(events[0].d.status).toBe(0);
    expect(events[0].d.error).toBe("ENOTFOUND");
  });

  it("reports an undici timeout under its cause code", async () => {
    const events: BugEvent[] = [];
    const host: { fetch?: unknown } = {
      fetch: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("timeout"), {
            code: "UND_ERR_HEADERS_TIMEOUT",
          }),
        });
      },
    };
    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      httpImpl: {},
      httpsImpl: {},
      fetchHost: host,
    });

    setProcessSessionId("s_fetch");
    await expect(
      (host.fetch as (url: string) => Promise<unknown>)(
        "https://api.stripe.com/v1/charges",
      ),
    ).rejects.toBeInstanceOf(TypeError);
    clearProcessSessionId("s_fetch");
    handle.stop();

    expect(events).toHaveLength(1);
    // `status: 0` plus `errorKind: "timeout"` is exactly the shape the
    // downstream-timeout detector matches on.
    expect(events[0].d.errorKind).toBe("timeout");
    expect(events[0].d.status).toBe(0);
    // `api.` is a gateway label, so the service is the thing behind it.
    expect(events[0].d.service).toBe("stripe");
  });

  it("never observes the capture endpoint itself", () => {
    const events: BugEvent[] = [];
    const { mod, requests } = fakeHttpModule();
    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      httpImpl: mod,
      httpsImpl: {},
      fetchHost: {},
      ignoreOrigins: ["http://ingest.crumbtrail.test"],
    });

    withProcessSession("s_self", () => {
      (mod.request as (...a: unknown[]) => unknown)(
        "http://ingest.crumbtrail.test/api/events",
        { method: "POST" },
      );
      requests[0].emit("response", { statusCode: 200 });
    });
    handle.stop();

    // One captured event here would produce another outbound call, forever.
    expect(events).toHaveLength(0);
  });

  it("carries the request it happened inside, and emits nothing without a session", () => {
    const events: BugEvent[] = [];
    const { mod, requests } = fakeHttpModule();
    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      httpImpl: mod,
      httpsImpl: {},
      fetchHost: {},
    });

    // No session anywhere: the intake would have nowhere to put this.
    (mod.request as (...a: unknown[]) => unknown)("http://svc.internal/a");
    requests[0].emit("response", { statusCode: 502 });
    expect(events).toHaveLength(0);

    runInBackendRequestContext(
      {
        requestId: "req_1",
        sessionId: "browser_session",
        sessionIdSource: "header",
      },
      () => {
        (mod.request as (...a: unknown[]) => unknown)("http://svc.internal/b");
        requests[1].emit("response", { statusCode: 502 });
      },
    );
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("browser_session");
    expect(events[0].d.requestId).toBe("req_1");
    expect(events[0].d.status).toBe(502);
  });

  it("restores the patched transports on stop", () => {
    const { mod } = fakeHttpModule();
    const originalRequest = mod.request;
    const host = { fetch: vi.fn() };
    const originalFetch = host.fetch;

    const handle = installOutboundHttpCapture({
      emit: vi.fn(),
      httpImpl: mod,
      httpsImpl: {},
      fetchHost: host,
    });
    expect(mod.request).not.toBe(originalRequest);
    expect(host.fetch).not.toBe(originalFetch);

    handle.stop();
    expect(mod.request).toBe(originalRequest);
    expect(host.fetch).toBe(originalFetch);
  });
});

describe("installOutboundHttpCapture against the real transports", () => {
  it("records a real outbound request through node:http", async () => {
    // The DEFAULT export, which is the module.exports object every
    // `require("http")` and `import http from "node:http"` also gets, and the
    // object the capture patches. A named ESM import (`import { request }`)
    // snapshots the binding at load time and is out of reach, the same way it
    // is for every other Node instrumentation.
    const http = (await import("node:http")).default;
    const events: BugEvent[] = [];

    const server = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.end("nope");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;

    const handle = installOutboundHttpCapture({
      emit: (event) => events.push(event),
      fetchHost: {},
    });

    setProcessSessionId("s_real");
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request(
          `http://127.0.0.1:${port}/upstream`,
          { method: "GET" },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        request.on("error", reject);
        request.end();
      });
    } finally {
      clearProcessSessionId("s_real");
      handle.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Patching the real `node:http` export is the whole point: a dependency
    // answering 503 is what turned the inbound request into a 500, and nothing
    // in the SDK had ever recorded it.
    const call = events.find((event) => event.k === "backend.http");
    expect(call).toBeDefined();
    expect(call?.d.status).toBe(503);
    expect(String(call?.d.url)).toContain("/upstream");
  });
});
