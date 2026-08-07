import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import { jsonResponse, opaqueResponse, request } from "./fixtures/net-res";

const STREAM_URL = "/api/orders/stream";

function sse(
  t: number,
  op: "open" | "error" | "close",
  extra: Record<string, unknown> = {},
): BugEvent {
  return {
    t,
    k: "net.sse",
    d: { url: STREAM_URL, op, ...extra },
  } as unknown as BugEvent;
}

function candidatesFor(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "stream_desync",
  );
}

const reconnect = [
  sse(1_000, "open"),
  sse(2_000, "error"),
  sse(3_000, "open", { reopen: true, count: 1 }),
];

describe("stream_desync", () => {
  it("names a reconnect that skipped a change to the resource", () => {
    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/orders"),
      jsonResponse(600, "a", [{ id: 1, status: "pending" }]),
      ...reconnect,
      request(4_000, "b", "GET", "/api/orders"),
      jsonResponse(4_100, "b", [{ id: 1, status: "shipped" }]),
    ]);
    expect(candidate).toBeDefined();
    expect(candidate.title).toBe(
      "Stream reconnected without replay and the resource had changed",
    );
    expect(candidate.severity).toBe("medium");
    expect(candidate.anchor.message).toContain("never delivered");
  });

  it("stays quiet about drift when the resource did not move", () => {
    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/orders"),
      jsonResponse(600, "a", [{ id: 1, status: "pending" }]),
      ...reconnect,
      request(4_000, "b", "GET", "/api/orders"),
      jsonResponse(4_100, "b", [{ id: 1, status: "pending" }]),
    ]);
    expect(candidate.severity).toBe("low");
    expect(candidate.anchor.message).toContain("could not be verified");
  });

  it("still reports a reconnect it cannot check, and says it cannot check it", () => {
    const [candidate] = candidatesFor(reconnect);
    expect(candidate).toBeDefined();
    expect(candidate.title).toBe(
      "Stream reconnected without any replay of what it missed",
    );
    expect(candidate.severity).toBe("low");
    expect(candidate.confidence).toBe("low");
    expect(candidate.anchor.message).toContain("could not be verified");
  });

  it("cannot compare a body the collector could size but not parse", () => {
    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/orders"),
      opaqueResponse(600, "a", { ct: "text/html" }),
      ...reconnect,
      request(4_000, "b", "GET", "/api/orders"),
      opaqueResponse(4_100, "b", { ct: "text/html" }),
    ]);
    expect(candidate.severity).toBe("low");
  });

  it("needs a reopen after the drop", () => {
    expect(
      candidatesFor([sse(1_000, "open"), sse(2_000, "error")]),
    ).toHaveLength(0);
  });

  it("does not read a plain open as a reconnect", () => {
    expect(
      candidatesFor([
        sse(1_000, "open"),
        sse(2_000, "error"),
        sse(3_000, "open"),
      ]),
    ).toHaveLength(0);
  });

  it("reads a close the same way as an error", () => {
    const [candidate] = candidatesFor([
      sse(1_000, "open"),
      sse(2_000, "close"),
      sse(3_000, "open", { reopen: true }),
    ]);
    expect(candidate).toBeDefined();
  });

  it("compares database rows the stream's own API root read", () => {
    const rowRead = (t: number, requestId: string, status: string): BugEvent =>
      ({
        t,
        k: "db.read",
        d: {
          engine: "postgres",
          table: "orders",
          pk: { id: 1 },
          row: { id: 1, status },
          requestId,
        },
      }) as unknown as BugEvent;

    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/orders/1"),
      rowRead(550, "a", "pending"),
      jsonResponse(600, "a", { ok: true }),
      ...reconnect,
      request(4_000, "b", "GET", "/api/orders/1"),
      rowRead(4_050, "b", "shipped"),
      jsonResponse(4_100, "b", { ok: true }),
    ]);
    expect(candidate.severity).toBe("medium");
    expect(candidate.anchor.message).toContain("orders");
  });

  it("ignores a resource outside the stream's API root", () => {
    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/inventory"),
      jsonResponse(600, "a", [{ id: 1, count: 4 }]),
      ...reconnect,
      request(4_000, "b", "GET", "/api/inventory"),
      jsonResponse(4_100, "b", [{ id: 1, count: 9 }]),
    ]);
    expect(candidate.severity).toBe("low");
  });
});

/**
 * The finding is a property of a STREAM, not of a protocol: it dropped, it came back, and nothing
 * replayed the gap. A socket-driven application hits it the same way a server-sent one does, and
 * before this the detector could only see one of the two.
 */
describe("stream_desync over a WebSocket", () => {
  function ws(
    t: number,
    op: "open" | "error" | "close",
    extra: Record<string, unknown> = {},
  ): BugEvent {
    return {
      t,
      k: "net.ws",
      d: { url: "wss://app.test/api/orders/stream", op, ...extra },
    } as unknown as BugEvent;
  }

  it("names a socket reconnect that skipped a change to the resource", () => {
    const [candidate] = candidatesFor([
      request(500, "a", "GET", "/api/orders"),
      jsonResponse(600, "a", [{ id: 1, status: "pending" }]),
      ws(1_000, "open"),
      ws(2_000, "close", { code: 1006, clean: false, received: 1 }),
      ws(3_000, "open", { reopen: true }),
      request(4_000, "b", "GET", "/api/orders"),
      jsonResponse(4_100, "b", [{ id: 1, status: "shipped" }]),
    ]);

    expect(candidate).toBeDefined();
    expect(candidate.title).toBe(
      "Stream reconnected without replay and the resource had changed",
    );
    expect(candidate.anchor.message).toContain("never delivered");
  });

  it("says nothing about a socket that opened once and stayed open", () => {
    expect(candidatesFor([ws(1_000, "open")])).toHaveLength(0);
  });
});
