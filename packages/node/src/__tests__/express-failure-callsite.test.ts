import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetBackendIntakeQueueForTest } from "../backend-intake";
import {
  createCrumbtrailExpressMiddleware,
  type CrumbtrailExpressRequest,
  type CrumbtrailExpressResponse,
} from "../express";

// Callsites otherwise ride on `db.diff`. A handler that catches its own error
// and returns a constant writes nothing, so before this the bundle could only
// repeat the uninformative body the user already saw.
class WritableResponse extends EventEmitter
  implements CrumbtrailExpressResponse {
  statusCode?: number;
  writableEnded = false;
  private headers: Record<string, string> = {
    "content-type": "application/json",
  };

  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  write(_chunk: unknown): boolean {
    return true;
  }

  end(_chunk?: unknown): this {
    this.writableEnded = true;
    return this;
  }
}

function fakeRequest(): CrumbtrailExpressRequest {
  return {
    method: "post",
    originalUrl: "/api/bookings/2/documents",
    headers: {
      "x-crumbtrail-session-id": "ses_1",
      "x-crumbtrail-request-id": "req_1",
    },
    route: { path: "/:id/documents" },
  } as unknown as CrumbtrailExpressRequest;
}

function eventsFrom(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls.flatMap((call) => {
    const init = call[1] as { body?: string } | undefined;
    if (!init?.body) return [];
    try {
      return (JSON.parse(init.body) as { events?: unknown[] }).events ?? [];
    } catch {
      return [];
    }
  });
}

describe("a 5xx response records where the app decided to fail", () => {
  beforeEach(() => resetBackendIntakeQueueForTest());

  it("attaches a callsite to the end event of a 500", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const res = new WritableResponse(500);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(
      fakeRequest(),
      res,
      vi.fn(),
    );
    res.write('{"error":"internal"}');
    res.end();
    res.emit("finish");
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1));

    const end = eventsFrom(fetch).find(
      (event) => (event as { k?: string }).k === "backend.req.end",
    ) as { d?: { responseCallsite?: { file?: string } } } | undefined;

    expect(end?.d?.responseCallsite?.file).toBeTruthy();
  });

  it("records nothing extra on a success", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const res = new WritableResponse(200);

    createCrumbtrailExpressMiddleware({ fetch, retries: 0 })(
      fakeRequest(),
      res,
      vi.fn(),
    );
    res.write('{"ok":true}');
    res.end();
    res.emit("finish");
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1));

    const end = eventsFrom(fetch).find(
      (event) => (event as { k?: string }).k === "backend.req.end",
    ) as { d?: { responseCallsite?: unknown } } | undefined;

    expect(end?.d?.responseCallsite).toBeUndefined();
  });
});
