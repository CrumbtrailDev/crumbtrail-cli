import { describe, it, expect, vi } from "vitest";
import { createCrumbtrailExpressMiddleware } from "../express";

/**
 * The backend plane used to record method, path, status and duration, and
 * nothing else. On the CalcDesk corpus that left 22 defects diagnosable only
 * down to "something returned 500 here", because the sentence the server
 * returned never reached the session unless the same request also went through
 * an instrumented browser.
 */

interface Sent {
  k: string;
  d: Record<string, unknown>;
}

function harness(options: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    try {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        events?: Sent[];
      };
      for (const event of parsed.events ?? []) sent.push(event);
    } catch {
      /* ignore */
    }
    return { ok: true, status: 200, text: async () => "" } as never;
  });

  const middleware = createCrumbtrailExpressMiddleware({
    endpoint: "http://localhost:9999",
    fetch: fetchImpl as never,
    captureRuntimeWarnings: false,
    ...options,
  });

  return { sent, middleware };
}

/** A response object shaped like the parts of Express's the recorder touches. */
function fakeRes(statusCode: number, headers: Record<string, string> = {}) {
  const listeners: Array<() => void> = [];
  const written: string[] = [];
  const res = {
    statusCode,
    once(event: string, listener: () => void) {
      if (event === "finish") listeners.push(listener);
      return res;
    },
    write(chunk: unknown) {
      written.push(String(chunk));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && typeof chunk !== "function")
        written.push(String(chunk));
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    finish() {
      for (const listener of listeners) listener();
    },
    written,
  };
  return res;
}

const req = (url = "/api/calcs/42/run", method = "POST") => ({
  method,
  url,
  originalUrl: url,
  path: url,
  headers: {
    "x-crumbtrail-session-id": "ses_20260729_120000_abcdef123456",
    "x-crumbtrail-request-id": "req-1",
  },
});

const endEvent = (sent: Sent[]) => sent.find((e) => e.k === "backend.req.end");

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

describe("backend response evidence", () => {
  it("records the response a 500 returned, structure intact", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(
      JSON.stringify({ error: '42P01: relation "_result_2" does not exist' }),
    );
    res.finish();
    await flush();

    const end = endEvent(sent);
    expect(end).toBeDefined();
    // The envelope survives: a reader learns the handler answered with an
    // `error` field and how long its text was.
    const body = JSON.parse(String(end?.d.responseBody)) as {
      error?: { $redacted?: string; len?: number };
    };
    expect(body.error).toBeDefined();
    expect(body.error?.len).toBe(42);
    expect(end?.d.responseHeaders).toMatchObject({
      "content-type": "application/json; charset=utf-8",
    });
  });

  /**
   * The sentence is free-form prose, so the v2 classifier places it unless the
   * application says otherwise — the same `keepFields` declaration the browser
   * SDK takes, now accepted on this plane too and carried in the event's policy
   * declaration so the capture server's re-classification honors it rather than
   * undoing it at rest.
   *
   * This assertion used to read `.not.toContain`, recording the gap while the
   * keep policy reached neither end of the backend path.
   */
  it("surfaces the sentence when the application declares the field", async () => {
    const { sent, middleware } = harness({ keepFields: ["error"] });
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "Database not found." }));
    res.finish();
    await flush();

    expect(String(endEvent(sent)?.d.responseBody)).toContain(
      "Database not found",
    );
  });

  /**
   * A plain sentence under an error-shaped name is the server explaining
   * itself, and it survives with no declaration at all: `{"msg":"Invalid login
   * credentials"}` arriving as a shape placeholder left a reader knowing a
   * sign-in failed and never why. A declaration is still what it takes for
   * anything richer — a sentence carrying an address, a phone number, or a name
   * the classifier cannot vouch for still goes.
   */
  it("surfaces a plain error sentence with no declaration", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "Database not found." }));
    res.finish();
    await flush();

    expect(String(endEvent(sent)?.d.responseBody)).toContain(
      "Database not found",
    );
  });

  it("still redacts personal data inside that sentence", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(
      JSON.stringify({ error: "No account for omar@example.com in eu-west" }),
    );
    res.finish();
    await flush();

    expect(String(endEvent(sent)?.d.responseBody)).not.toContain(
      "omar@example.com",
    );
  });

  it("carries the declaration to the capture server", async () => {
    const { sent, middleware } = harness({ keepFields: ["error"] });
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "Database not found." }));
    res.finish();
    await flush();

    const redaction = endEvent(sent)?.d.redaction as { keep?: string[] };
    expect(redaction?.keep).toEqual(["error"]);
  });

  /** A declared name is exempt from the name rules, never from the value ones. */
  it("does not let a declared keep smuggle a secret", async () => {
    const { sent, middleware } = harness({ keepFields: ["error"] });
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "contact billing@example.com" }));
    res.finish();
    await flush();

    expect(String(endEvent(sent)?.d.responseBody)).not.toContain(
      "billing@example.com",
    );
  });

  it("leaves a successful response body alone by default", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(200, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ ok: true, rows: 12 }));
    res.finish();
    await flush();

    const end = endEvent(sent);
    expect(end?.d.responseBody).toBeUndefined();
    // Headers still land: a content type that disagrees with what the caller
    // parsed is itself a defect, and it costs nothing to keep.
    expect(end?.d.responseHeaders).toBeDefined();
  });

  it('captures a successful response under "all"', async () => {
    const { sent, middleware } = harness({ captureResponseBody: "all" });
    const res = fakeRes(201, JSON_HEADERS);
    middleware(req("/api/forms/adjustments"), res as never, () => {});
    res.end(JSON.stringify({ ok: true, id: 2291 }));
    res.finish();
    await flush();

    expect(String(endEvent(sent)?.d.responseBody)).toContain("2291");
  });

  it("records nothing when capture is off", async () => {
    const { sent, middleware } = harness({ captureResponseBody: "off" });
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "boom" }));
    res.finish();
    await flush();

    const end = endEvent(sent);
    expect(end?.d.responseBody).toBeUndefined();
    expect(end?.d.responseHeaders).toBeUndefined();
  });

  it("truncates at the cap and says so", async () => {
    const { sent, middleware } = harness({ responseBodyMaxBytes: 32 });
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "x".repeat(500) }));
    res.finish();
    await flush();

    const end = endEvent(sent);
    expect(String(end?.d.responseBody).length).toBeLessThanOrEqual(64);
    expect(end?.d.responseBodyTruncated).toBe(true);
  });

  it("keeps a binary payload out of the session", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, { "content-type": "application/octet-stream" });
    middleware(req(), res as never, () => {});
    res.end(" binary");
    res.finish();
    await flush();

    const end = endEvent(sent);
    expect(end?.d.responseBody).toBeUndefined();
    expect(end?.d.responseHeaders).toBeDefined();
  });

  it("never records a header outside the allowlist", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, {
      ...JSON_HEADERS,
      "set-cookie": "session=secret",
      authorization: "Bearer secret",
    });
    middleware(req(), res as never, () => {});
    res.end(JSON.stringify({ error: "boom" }));
    res.finish();
    await flush();

    const headers = endEvent(sent)?.d.responseHeaders as Record<string, string>;
    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("secret");
  });

  it("redacts a captured body through the shared policy", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.end(
      JSON.stringify({
        error: "insert failed",
        password: "hunter2-not-a-real-password",
      }),
    );
    res.finish();
    await flush();

    const body = String(endEvent(sent)?.d.responseBody);
    expect(body).not.toContain("hunter2-not-a-real-password");
  });

  it("passes the response through untouched", async () => {
    const { middleware } = harness();
    const res = fakeRes(200, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.write("first ");
    res.end("second");
    expect(res.written.join("")).toBe("first second");
  });

  it("assembles a body written in several chunks", async () => {
    const { sent, middleware } = harness();
    const res = fakeRes(500, JSON_HEADERS);
    middleware(req(), res as never, () => {});
    res.write('{"code":42,"rows":');
    res.write("17");
    res.end("}");
    res.finish();
    await flush();

    // Chunk assembly must preserve safe counts without bypassing identifier redaction.
    const body = JSON.parse(String(endEvent(sent)?.d.responseBody)) as {
      code?: { $redacted?: string };
      rows?: number;
    };
    expect(body).toEqual({
      code: expect.objectContaining({ $redacted: expect.any(String) }),
      rows: 17,
    });
  });

  it("survives a response with no write, end or getHeader", async () => {
    const { sent, middleware } = harness();
    const listeners: Array<() => void> = [];
    const bare = {
      statusCode: 500,
      once(event: string, listener: () => void) {
        if (event === "finish") listeners.push(listener);
        return bare;
      },
    };
    middleware(req(), bare as never, () => {});
    for (const listener of listeners) listener();
    await flush();

    const end = endEvent(sent);
    expect(end).toBeDefined();
    expect(end?.d.statusCode).toBe(500);
    expect(end?.d.responseBody).toBeUndefined();
  });
});
