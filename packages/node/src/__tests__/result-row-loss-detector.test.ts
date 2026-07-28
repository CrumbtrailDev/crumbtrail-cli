import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import {
  jsonResponse,
  legacyJsonResponse,
  opaqueResponse,
  request,
} from "./fixtures/net-res";

function get(t: number, url = "/api/products", requestId = "req-a"): BugEvent {
  return request(t, requestId, "GET", url);
}

function rows(
  count: number,
  start = 20,
  requestId = "req-a",
  table = "products",
): BugEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    t: start + i,
    k: "db.read",
    d: {
      engine: "postgres",
      table,
      pk: { id: i + 1 },
      row: { id: i + 1, name: `row ${i + 1}` },
      requestId,
    },
  })) as unknown as BugEvent[];
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

describe("result_row_loss", () => {
  it("names rows the backend read that the response never carried", () => {
    const found = detectors([
      get(10),
      ...rows(3),
      jsonResponse(40, "req-a", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("counts the loss in the title", () => {
    const candidate = buildEvidenceCandidates(
      [get(10), ...rows(3), jsonResponse(40, "req-a", [{ id: 1 }, { id: 2 }])],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate?.title).toContain("1 of 3 rows read from products");
    expect(candidate?.severity).toBe("high");
    expect(candidate?.confidence).toBe("high");
  });

  it("reads a capped top-level array's true length from arrayTotal.$", () => {
    // 25 items in the body, 20 captured, 30 rows read: the loss is 5, not 10.
    const payload = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const candidate = buildEvidenceCandidates(
      [get(10), ...rows(30), jsonResponse(60, "req-a", payload)],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate?.title).toContain("5 of 30 rows");
  });

  it("reads a capped nested array's true length from its own path key", () => {
    const payload = {
      items: Array.from({ length: 57 }, (_, i) => ({ id: i + 1 })),
      page: 1,
    };
    const candidate = buildEvidenceCandidates(
      [get(10), ...rows(60), jsonResponse(90, "req-a", payload)],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate?.title).toContain("3 of 60 rows");
  });

  it("is not silenced by a truncated flag that a string cap set", () => {
    // `truncated` is also raised by the 120-character string cap, which says
    // nothing about how many items the array had.
    const payload = [
      { id: 1, note: "x".repeat(400) },
      { id: 2, note: "ok" },
    ];
    const found = detectors([
      get(10),
      ...rows(4),
      jsonResponse(40, "req-a", payload),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("reads a named collection inside a response object", () => {
    const found = detectors([
      get(10),
      ...rows(4),
      jsonResponse(40, "req-a", { items: [{ id: 1 }], page: 1 }),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("falls back to the redacted body text when there is no bodyMeta", () => {
    // Backend-captured and replayed sessions carry `d.body` alone.
    const found = detectors([
      get(10),
      ...rows(3),
      legacyJsonResponse(40, "req-a", [{ id: 1 }]),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("stays silent when the response carried every row", () => {
    const found = detectors([
      get(10),
      ...rows(2),
      jsonResponse(40, "req-a", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("does not count aggregate reads, which have no primary key", () => {
    const countRow = {
      t: 25,
      k: "db.read",
      d: {
        engine: "postgres",
        table: "products",
        pk: null,
        row: { count: 900 },
        requestId: "req-a",
      },
    } as unknown as BugEvent;
    const found = detectors([
      get(10),
      ...rows(2),
      countRow,
      jsonResponse(40, "req-a", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the request read more than one table", () => {
    // Nothing maps a response array back to one of two tables without guessing.
    const found = detectors([
      get(10),
      ...rows(3, 20, "req-a", "products"),
      ...rows(2, 30, "req-a", "categories"),
      jsonResponse(40, "req-a", [{ id: 1 }]),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent on a mutating request", () => {
    // A POST reads rows to validate and answers with one object; that is not loss.
    const found = detectors([
      request(10, "req-a", "POST", "/api/orders"),
      ...rows(3, 20, "req-a", "orders"),
      jsonResponse(40, "req-a", { id: 1, ok: true }),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the server returned exactly the page it was asked for", () => {
    const found = detectors([
      get(10, "/api/products?limit=2"),
      ...rows(5),
      jsonResponse(40, "req-a", [{ id: 1 }, { id: 2 }]),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the collector could size the body but not parse it", () => {
    // Cross-origin, non-JSON, over 32KB, or unparseable: size facts, no data.
    const found = detectors([
      get(10),
      ...rows(5),
      opaqueResponse(40, "req-a", { bytes: 40_000 }),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the body carries two candidate arrays", () => {
    const found = detectors([
      get(10),
      ...rows(5),
      jsonResponse(40, "req-a", { left: [{ id: 1 }], right: [{ id: 2 }] }),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("falls back to the next display snapshot, and says the count is not a row count", () => {
    const snapshot = {
      t: 50,
      k: "ui.num",
      d: { region: "results", items: [{ label: "Row 1", value: 1 }] },
    } as unknown as BugEvent;
    const bodilessResponse = {
      t: 40,
      k: "net.res",
      d: { requestId: "req-a", st: 200, dur: 8 },
    } as unknown as BugEvent;
    const candidate = buildEvidenceCandidates(
      [get(10), ...rows(4), bodilessResponse, snapshot],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate).toBeDefined();
    // An on-screen number count is not a row count, and the candidate says so.
    expect(candidate?.severity).toBe("medium");
    expect(candidate?.confidence).toBe("low");
    expect(candidate?.anchor.message).toContain("not a row count");
  });
});
