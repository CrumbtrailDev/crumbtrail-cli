import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function request(
  t: number,
  url = "/api/products",
  requestId = "req-a",
  method = "GET",
): BugEvent {
  return { t, k: "net.req", d: { requestId, m: method, url } } as BugEvent;
}

function response(
  t: number,
  body: unknown,
  requestId = "req-a",
  st = 200,
): BugEvent {
  return { t, k: "net.res", d: { requestId, st, dur: 9, body } } as BugEvent;
}

function jsonBody(
  data: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ct: "json", bytes: 256, truncated: false, data, ...extra };
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
      request(10),
      ...rows(3),
      response(40, jsonBody([{ id: 1 }, { id: 2 }])),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("counts the loss in the title", () => {
    const candidate = buildEvidenceCandidates(
      [request(10), ...rows(3), response(40, jsonBody([{ id: 1 }, { id: 2 }]))],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate?.title).toContain("1 of 3 rows read from products");
    expect(candidate?.severity).toBe("high");
    expect(candidate?.confidence).toBe("high");
  });

  it("reads the true array length from arrayTotal, not the captured slice", () => {
    const candidate = buildEvidenceCandidates(
      [
        request(10),
        ...rows(6),
        response(40, jsonBody([{ id: 1 }, { id: 2 }], { arrayTotal: 4 })),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate?.title).toContain("2 of 6 rows");
  });

  it("reads a named collection inside a response object", () => {
    const found = detectors([
      request(10),
      ...rows(4),
      response(40, jsonBody({ items: [{ id: 1 }], page: 1 })),
    ]);
    expect(found).toContain("result_row_loss");
  });

  it("stays silent when the response carried every row", () => {
    const found = detectors([
      request(10),
      ...rows(2),
      response(40, jsonBody([{ id: 1 }, { id: 2 }])),
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
      request(10),
      ...rows(2),
      countRow,
      response(40, jsonBody([{ id: 1 }, { id: 2 }])),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the request read more than one table", () => {
    // Nothing maps a response array back to one of two tables without guessing.
    const found = detectors([
      request(10),
      ...rows(3, 20, "req-a", "products"),
      ...rows(2, 30, "req-a", "categories"),
      response(40, jsonBody([{ id: 1 }])),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent on a mutating request", () => {
    // A POST reads rows to validate and answers with one object; that is not loss.
    const found = detectors([
      request(10, "/api/orders", "req-a", "POST"),
      ...rows(3, 20, "req-a", "orders"),
      response(40, jsonBody({ id: 1, ok: true })),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the server returned exactly the page it was asked for", () => {
    const found = detectors([
      request(10, "/api/products?limit=2"),
      ...rows(5),
      response(40, jsonBody([{ id: 1 }, { id: 2 }])),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when a truncated body carries no total to stand in", () => {
    const found = detectors([
      request(10),
      ...rows(5),
      response(40, { ct: "json", bytes: 99_999, truncated: true, data: [{ id: 1 }] }),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("stays silent when the body carries two candidate arrays", () => {
    const found = detectors([
      request(10),
      ...rows(5),
      response(40, jsonBody({ left: [{ id: 1 }], right: [{ id: 2 }] })),
    ]);
    expect(found).not.toContain("result_row_loss");
  });

  it("falls back to the next display snapshot, and says the count is not a row count", () => {
    const snapshot = {
      t: 50,
      k: "ui.num",
      d: {
        region: "results",
        items: [{ label: "Row 1", value: 1 }],
      },
    } as unknown as BugEvent;
    const candidate = buildEvidenceCandidates(
      [request(10), ...rows(4), response(40, undefined), snapshot],
      { start: 0 },
    ).find((entry) => entry.detector === "result_row_loss");
    expect(candidate).toBeDefined();
    // An on-screen number count is not a row count, and the candidate says so.
    expect(candidate?.severity).toBe("medium");
    expect(candidate?.confidence).toBe("low");
    expect(candidate?.anchor.message).toContain("not a row count");
  });
});
