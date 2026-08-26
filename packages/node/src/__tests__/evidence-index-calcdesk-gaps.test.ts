import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * Detectors and ranking fixes written against the CalcDesk third corpus
 * (CD-01…CD-50), mined from an enterprise support corpus and weighted toward
 * failures that return a success status. Every fixture mirrors a shape taken
 * from the live run recorded in `calcdesk/DETECTION-SCORECARD.md`
 * (`ses_20260729_124058_e84e18cb308a`), not a synthetic minimum.
 */

let nextId = 500;

function beReq(
  t: number,
  requestId: string,
  method: string,
  pathname: string,
  statusCode: number,
  route?: string,
): BugEvent {
  return {
    t,
    k: "backend.req.end",
    d: {
      requestId,
      method,
      url: pathname,
      pathname,
      route: route ?? "/",
      statusCode,
      durationMs: 4,
    },
  };
}

function diff(
  t: number,
  requestId: string,
  table: string,
  after: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "sqlite",
      op: "insert",
      table,
      pk: { id: after.id },
      after,
      requestId,
    },
  };
}

function read(
  t: number,
  requestId: string,
  table: string,
  row: Record<string, unknown>,
): BugEvent {
  return { t, k: "db.read", d: { engine: "sqlite", table, row, requestId } };
}

function netReq(
  t: number,
  requestId: string,
  url: string,
  method = "GET",
): BugEvent {
  return { t, k: "net.req", d: { id: nextId++, method, url, requestId } };
}

function netRes(
  t: number,
  requestId: string,
  status: number,
  hdrs: Record<string, string>,
  body?: string,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      id: nextId - 1,
      st: status,
      requestId,
      hdrs,
      ...(body === undefined ? {} : { body }),
    },
  };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

const all = (events: BugEvent[], start = 1000) =>
  buildEvidenceCandidates(events, { start });

const HTML = { "content-type": "text/html; charset=utf-8" };
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

/** A request that wrote, so the session proves write instrumentation is live. */
const someoneWrote = (t: number): BugEvent[] => [
  beReq(t, "w0", "POST", "/api/imports/5/run", 200),
  read(t - 2, "w0", "saved_imports", { id: 5 }),
  diff(t - 1, "w0", "data_rows", { id: 9, key_text: "P1" }),
];

describe("acknowledged_write_never_landed (CD-18)", () => {
  it("flags a 201 that read the database and wrote nothing", () => {
    const events = [
      ...someoneWrote(1100),
      read(1200, "r1", "forms", { id: 3, name: "adjustments" }),
      read(1201, "r1", "data_rows", { id: 50 }),
      beReq(1210, "r1", "POST", "/api/forms/adjustments", 201, "/:name"),
    ];
    const found = find(events, "acknowledged_write_never_landed");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("/api/forms/adjustments");
    expect(found[0].severity).toBe("high");
  });

  it("stays silent when the 201 did write", () => {
    const events = [
      ...someoneWrote(1100),
      read(1200, "r1", "forms", { id: 3 }),
      beReq(1210, "r1", "POST", "/api/forms/adjustments", 201),
      diff(1205, "r1", "data_rows", { id: 51, key_text: "Q1" }),
    ];
    expect(find(events, "acknowledged_write_never_landed")).toHaveLength(0);
  });

  it("still flags, at lower confidence, when the handler aborted before its first statement", () => {
    // The swallowed-transaction shape leaves no read behind either, so reads
    // raise confidence rather than gate the finding.
    const events = [
      ...someoneWrote(1100),
      beReq(1210, "r1", "POST", "/api/forms/adjustments", 201),
    ];
    const found = find(events, "acknowledged_write_never_landed");
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBe("medium");
  });

  it("stays silent when nothing in the session wrote at all", () => {
    const events = [
      read(1200, "r1", "forms", { id: 3 }),
      beReq(1210, "r1", "POST", "/api/forms/adjustments", 201),
    ];
    expect(find(events, "acknowledged_write_never_landed")).toHaveLength(0);
  });

  it("stays silent on a plain 200, which claims nothing about a new record", () => {
    const events = [
      ...someoneWrote(1100),
      read(1200, "r1", "data_rows", { id: 3 }),
      beReq(1210, "r1", "POST", "/api/reports/search", 200),
    ];
    expect(find(events, "acknowledged_write_never_landed")).toHaveLength(0);
  });
});

describe("api_route_returned_document (CD-41)", () => {
  it("flags an API route that answered with an HTML document", () => {
    const events = [
      netReq(1200, "r1", "http://localhost:7441/api/workflows/1/attachments", "POST"),
      netRes(1220, "r1", 201, HTML, "<!doctype html><html><head></head></html>"),
    ];
    const found = find(events, "api_route_returned_document");
    expect(found).toHaveLength(1);
    expect(found[0].anchor.url).toContain("/api/workflows/1/attachments");
    expect(found[0].anchor.status).toBe(201);
  });

  it("still flags when redaction removed the body, because the type is proof", () => {
    const events = [
      netReq(1200, "r1", "http://localhost:7441/api/workflows/1/attachments", "POST"),
      netRes(1220, "r1", 201, HTML, "[REDACTED]"),
    ];
    expect(find(events, "api_route_returned_document")).toHaveLength(1);
  });

  it("stays silent on an ordinary page navigation", () => {
    const events = [
      netReq(1200, "r1", "http://localhost:7440/workflows"),
      netRes(1220, "r1", 200, HTML, "<!doctype html><html></html>"),
    ];
    expect(find(events, "api_route_returned_document")).toHaveLength(0);
  });

  it("stays silent when the API route returned JSON", () => {
    const events = [
      netReq(1200, "r1", "http://localhost:7441/api/workflows"),
      netRes(1220, "r1", 200, JSON_TYPE, '{"workflows":[]}'),
    ];
    expect(find(events, "api_route_returned_document")).toHaveLength(0);
  });
});

describe("backend findings name the path, not the route pattern", () => {
  it("titles two different failing endpoints distinguishably", () => {
    const events = [
      beReq(1200, "r1", "POST", "/api/imports/6/run", 500, "/:id/run"),
      beReq(1300, "r2", "POST", "/api/calcs/42/run", 500, "/:id/run"),
    ];
    const found = all(events).filter((c) => c.detector === "backend_http_error");
    expect(found).toHaveLength(2);
    const titles = found.map((c) => c.title).join(" ");
    expect(titles).toContain("/api/imports/6/run");
    expect(titles).toContain("/api/calcs/42/run");
    expect(titles).not.toContain("/:id/run");
  });

  it("falls back to the route pattern when no pathname was captured", () => {
    const events: BugEvent[] = [
      {
        t: 1200,
        k: "backend.req.end",
        d: { requestId: "r1", method: "GET", route: "/:id/data", statusCode: 500 },
      },
    ];
    const found = all(events).filter((c) => c.detector === "backend_http_error");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("/:id/data");
  });
});

describe("client errors are silent when their session consequence is clean", () => {
  const forbidden: BugEvent[] = [
    beReq(1200, "r1", "GET", "/api/reports/1/link/7", 403, "/:id/link/:target"),
  ];

  it("does not special-case a bare 403 into a finding", () => {
    const found = all(forbidden).filter(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(found).toHaveLength(0);
  });

  it("does not raise sibling client errors just because one also occurred", () => {
    const events = [beReq(1100, "r0", "GET", "/api/me", 401), ...forbidden];
    const found = all(events).filter(
      (c) =>
        c.detector === "backend_http_client_error" && c.anchor.status === 403,
    );
    expect(found).toHaveLength(0);
  });

  it("does not mint a backend issue for a bare 401", () => {
    const events = [beReq(1200, "r1", "GET", "/api/me", 401)];
    const found = all(events).filter(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(found).toHaveLength(0);
  });
});
