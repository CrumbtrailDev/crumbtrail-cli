import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";
import {
  jsonResponse,
  legacyJsonResponse,
  request as netRequest,
} from "./fixtures/net-res";

function request(
  t: number,
  url = "/api/catalog",
  requestId = "req-a",
): BugEvent {
  return netRequest(t, requestId, "GET", url);
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function response(
  t: number,
  payload: unknown,
  requestId = "req-a",
  status = 200,
): BugEvent {
  return jsonResponse(t, requestId, payload, { status });
}

describe("filter_contradiction", () => {
  it("fires when returned rows contradict an echoed scalar constraint", () => {
    const found = detectors([
      request(10),
      response(20, {
        filters: { category: "audio" },
        results: [
          { id: 1, category: "audio" },
          { id: 2, category: "desk" },
        ],
      }),
    ]);
    expect(found).toContain("filter_contradiction");
  });

  it("names the constraint, declared value, and violating value", () => {
    const candidate = buildEvidenceCandidates(
      [
        request(10, "/api/catalog"),
        response(20, {
          filters: { category: "audio" },
          results: [{ id: 2, category: "desk" }],
        }),
      ],
      { start: 0 },
    ).find((entry) => entry.detector === "filter_contradiction");

    expect(candidate?.title).toBe(
      "Response rows contradict an echoed constraint category",
    );
    expect(candidate?.severity).toBe("high");
    expect(candidate?.confidence).toBe("high");
    expect(candidate?.anchor.t).toBe(20);
    expect(candidate?.anchor.message).toContain("category=audio");
    expect(candidate?.anchor.message).toContain("category=desk");
    expect(candidate?.anchor.status).toBe(200);
  });

  it("works with a top-level response collection and legacy body text", () => {
    const found = detectors([
      request(10),
      legacyJsonResponse(20, "req-a", {
        applied: { status: "ready" },
        data: [{ id: 1, status: "failed" }],
      }),
    ]);
    expect(found).toContain("filter_contradiction");
  });

  it("compares boolean scalar constraints without coercion", () => {
    const found = detectors([
      request(10),
      response(20, {
        appliedConstraints: { active: true },
        items: [{ id: 1, active: false }],
      }),
    ]);
    expect(found).toContain("filter_contradiction");
  });

  it("stays silent when an echoed key is absent from the returned items", () => {
    const found = detectors([
      request(10),
      response(20, {
        filters: { category: "audio" },
        items: [{ id: 1, name: "speaker" }],
      }),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["wildcard sentinel", "*"],
    ["all sentinel", "all"],
  ])("stays silent for a %s echoed value", (_label, value) => {
    const found = detectors([
      request(10),
      response(20, {
        filters: { category: value },
        items: [{ id: 1, category: "desk" }],
      }),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("stays silent when either compared value was redacted", () => {
    const echoedRedaction = detectors([
      request(10),
      response(20, {
        filters: { category: "[REDACTED]" },
        items: [{ id: 1, category: "desk" }],
      }),
    ]);
    const rowRedaction = detectors([
      request(10),
      response(20, {
        filters: { category: "audio" },
        items: [{ id: 1, category: "[REDACTED]" }],
      }),
    ]);

    expect(echoedRedaction).not.toContain("filter_contradiction");
    expect(rowRedaction).not.toContain("filter_contradiction");
  });

  it("stays silent when comparison would need case or type normalization", () => {
    const caseOnly = detectors([
      request(10),
      response(20, {
        filters: { category: "audio" },
        items: [{ id: 1, category: "AUDIO" }],
      }),
    ]);
    const typeOnly = detectors([
      request(10),
      response(20, {
        filters: { code: "1" },
        items: [{ id: 1, code: 1 }],
      }),
    ]);

    expect(caseOnly).not.toContain("filter_contradiction");
    expect(typeOnly).not.toContain("filter_contradiction");
  });

  it("stays silent for deferred range, paging, and ordering semantics", () => {
    const found = detectors([
      request(10),
      response(20, {
        filters: {
          maxPrice: 800000,
          limit: 20,
          sort: "price_asc",
        },
        items: [{ id: 1, maxPrice: 400000, limit: 45, sort: "price_desc" }],
      }),
    ]);

    expect(found).not.toContain("filter_contradiction");
  });

  it("stays silent for a failed response", () => {
    const found = detectors([
      request(10),
      response(
        20,
        {
          filters: { category: "audio" },
          items: [{ id: 1, category: "desk" }],
        },
        "req-a",
        500,
      ),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });

  it("stays silent when more than one constraint object is plausible", () => {
    const found = detectors([
      request(10),
      response(20, {
        filters: { category: "audio" },
        applied: { category: "audio" },
        items: [{ id: 1, category: "desk" }],
      }),
    ]);
    expect(found).not.toContain("filter_contradiction");
  });
});
