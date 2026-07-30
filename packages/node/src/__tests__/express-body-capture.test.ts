import { EventEmitter } from "node:events";
import type { BugEvent } from "crumbtrail-core";
import { describe, expect, it, vi } from "vitest";
import { BACKEND_REQUEST_END_EVENT } from "../backend-events";
import {
  isCapturableContentTypeForTest,
  createCrumbtrailExpressMiddleware,
  type CrumbtrailExpressRequest,
  type CrumbtrailExpressResponse,
} from "../express";

/**
 * A response that records what the application wrote, the way a real
 * ServerResponse does, so the middleware's write/end wrappers are exercised
 * rather than mocked around.
 */
class FakeResponse extends EventEmitter implements CrumbtrailExpressResponse {
  statusCode?: number;
  written: string[] = [];
  headers: Record<string, string> = {};

  constructor(statusCode?: number, contentType?: string) {
    super();
    this.statusCode = statusCode;
    if (contentType) this.headers["content-type"] = contentType;
  }

  getHeader = (name: string): unknown => this.headers[name.toLowerCase()];

  write = (chunk: unknown): boolean => {
    this.written.push(String(chunk));
    return true;
  };

  end = (chunk?: unknown): unknown => {
    if (chunk !== undefined) this.written.push(String(chunk));
    this.emit("finish");
    return this;
  };
}

function fakeRequest(
  overrides: Partial<CrumbtrailExpressRequest> = {},
): CrumbtrailExpressRequest {
  return {
    method: "GET",
    originalUrl: "/api/shifts/7/duration",
    headers: {
      "x-crumbtrail-session-id": "ses_body",
      "x-crumbtrail-request-id": "req_body",
    },
    ...overrides,
  };
}

function okResponse() {
  return { ok: true, status: 202, text: async () => "" } as never;
}

function sentEvents(fetch: ReturnType<typeof vi.fn>): BugEvent[] {
  return fetch.mock.calls.flatMap((call) => {
    const body = (call[1] as { body?: string })?.body;
    if (typeof body !== "string") return [];
    try {
      const parsed = JSON.parse(body) as { events?: BugEvent[] };
      return parsed.events ?? [];
    } catch {
      return [];
    }
  });
}

function endEvent(fetch: ReturnType<typeof vi.fn>): BugEvent | undefined {
  return sentEvents(fetch).find((event) => event.k === BACKEND_REQUEST_END_EVENT);
}

describe("express backend body capture", () => {
  it("captures the response payload the application returned", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest();
    const res = new FakeResponse(200, "application/json; charset=utf-8");

    createCrumbtrailExpressMiddleware({ fetch })(req, res, () => {});
    res.end(JSON.stringify({ duration_hours: 8, reference_hours: 7 }));
    await Promise.resolve();

    const end = endEvent(fetch);
    expect(end).toBeDefined();
    // The value that decides the defect has to survive, not just the status.
    expect(String(end?.d.body)).toContain("\"duration_hours\":8");
    expect(String(end?.d.body)).toContain("\"reference_hours\":7");
    // And the application still received exactly what it wrote.
    expect(res.written.join("")).toBe(
      JSON.stringify({ duration_hours: 8, reference_hours: 7 }),
    );
  });

  it("captures the parsed request payload", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const req = fakeRequest({
      method: "POST",
      body: { shift_id: 4, worker: "mel", idempotency_key: "cal-7" },
    });
    const res = new FakeResponse(200, "application/json");

    createCrumbtrailExpressMiddleware({ fetch })(req, res, () => {});
    res.end("{\"count\":2}");
    await Promise.resolve();

    const end = endEvent(fetch);
    expect(String(end?.d.reqBody)).toContain("\"shift_id\":4");
    expect(String(end?.d.body)).toContain("\"count\":2");
  });

  it("honours keepFields for a field the free-text rule would redact", async () => {
    const withKeep = vi.fn().mockResolvedValue(okResponse());
    const withoutKeep = vi.fn().mockResolvedValue(okResponse());
    const payload = JSON.stringify({ label: "ICU night DST", id: 7 });

    for (const [fetch, keepFields] of [
      [withKeep, ["label"]],
      [withoutKeep, undefined],
    ] as const) {
      const res = new FakeResponse(200, "application/json");
      createCrumbtrailExpressMiddleware({
        fetch,
        ...(keepFields ? { keepFields: [...keepFields] } : {}),
      })(fakeRequest(), res, () => {});
      res.end(payload);
      await Promise.resolve();
    }

    expect(String(endEvent(withKeep)?.d.body)).toContain("ICU night DST");
    expect(String(endEvent(withoutKeep)?.d.body)).toContain("[REDACTED]");
  });

  it("skips a binary response and still emits the end event", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const res = new FakeResponse(200, "image/png");

    createCrumbtrailExpressMiddleware({ fetch })(fakeRequest(), res, () => {});
    res.end("PNG\r\n\n binary bytes");
    await Promise.resolve();

    const end = endEvent(fetch);
    expect(end).toBeDefined();
    expect(end?.d.body).toBeUndefined();
  });

  it("caps a large payload rather than shipping the whole thing", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const res = new FakeResponse(200, "application/json");

    createCrumbtrailExpressMiddleware({ fetch, maxBodyChars: 64 })(
      fakeRequest(),
      res,
      () => {},
    );
    res.end(JSON.stringify({ rows: "x".repeat(5_000) }));
    await Promise.resolve();

    const end = endEvent(fetch);
    const captured = JSON.stringify(end?.d.body ?? "");
    expect(captured.length).toBeLessThan(400);
  });

  it("captures nothing when the caller opts out", async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse());
    const res = new FakeResponse(200, "application/json");

    createCrumbtrailExpressMiddleware({ fetch, captureBodies: false })(
      fakeRequest({ method: "POST", body: { worker: "dana" } }),
      res,
      () => {},
    );
    res.end("{\"ok\":true}");
    await Promise.resolve();

    const end = endEvent(fetch);
    expect(end?.d.body).toBeUndefined();
    expect(end?.d.reqBody).toBeUndefined();
  });
});

// The content-type gate decides what counts as evidence at all. It is written as
// text-bearing families, not exact types: a JSON:API document, an ndjson stream
// or a SOAP envelope is as diagnosable as plain JSON and must not need its own
// entry to be captured.
describe("capturable content types", () => {
  const CAPTURABLE = [
    "application/json",
    "application/json; charset=utf-8",
    "application/vnd.api+json",
    "application/ld+json",
    "application/problem+json",
    "application/x-ndjson",
    "application/xml",
    "application/soap+xml",
    "application/graphql",
    "application/csv",
    "application/yaml",
    "application/x-www-form-urlencoded",
    "text/plain",
    "text/html; charset=utf-8",
    "text/csv",
    "text/event-stream",
  ];
  const SKIPPED = [
    "image/png",
    "image/svg+xml; charset=utf-8".replace("svg+xml", "avif"),
    "font/woff2",
    "application/zip",
    "application/octet-stream",
    "application/pdf",
    "video/mp4",
    "audio/mpeg",
  ];

  it("captures every text-bearing family", () => {
    for (const type of CAPTURABLE)
      expect({ type, capturable: isCapturableContentTypeForTest(type) }).toEqual({
        type,
        capturable: true,
      });
  });

  it("skips binary payloads", () => {
    for (const type of SKIPPED)
      expect({ type, capturable: isCapturableContentTypeForTest(type) }).toEqual({
        type,
        capturable: false,
      });
  });
});
