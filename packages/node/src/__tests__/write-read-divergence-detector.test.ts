import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function request(
  requestId: string,
  t: number,
  method: string,
  body?: unknown,
): BugEvent {
  return {
    t,
    k: "net.req",
    d: { id: requestId, requestId, method, url: `/records/${requestId}`, body },
  } as unknown as BugEvent;
}

function response(
  requestId: string,
  t: number,
  body: unknown,
  st = 200,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: { id: requestId, requestId, st, body: JSON.stringify(body) },
  } as unknown as BugEvent;
}

function findings(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).filter(
    (candidate) => candidate.detector === "write_read_divergence",
  );
}

describe("write_read_divergence", () => {
  it("fires on a truncated multibyte read-back and names truncation", () => {
    const written = "Very happy indeed!!!!!!!!!!🎧";
    const read = "Very happy indeed!!!!!!!!!!�";
    const candidates = findings([
      request("write-1", 100, "POST", { id: "review-1", review: written }),
      response("write-1", 120, { id: "review-1", review: written }),
      request("read-1", 200, "GET"),
      response("read-1", 220, { id: "review-1", review: read }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toContain("truncation");
    expect(candidates[0]?.title).toContain(written);
    expect(candidates[0]?.title).toContain(read);
  });

  it("ignores server-added identifiers and timestamps", () => {
    const candidates = findings([
      request("write-1", 100, "POST", {
        clientId: "review-1",
        review: "Very happy indeed",
      }),
      response("write-1", 120, {
        clientId: "review-1",
        review: "Very happy indeed",
      }),
      request("read-1", 200, "GET"),
      response("read-1", 220, {
        clientId: "review-1",
        review: "Very happy indeed",
        id: 481,
        createdAt: "2026-08-26T05:00:00.000Z",
      }),
    ]);

    expect(candidates).toHaveLength(0);
  });

  it("does not compare redacted placeholders as real values", () => {
    const candidates = findings([
      request("write-1", 100, "POST", {
        id: "review-1",
        review: "[REDACTED]",
      }),
      response("write-1", 120, {
        id: "review-1",
        review: "[REDACTED]",
      }),
      request("read-1", 200, "GET"),
      response("read-1", 220, {
        id: "review-1",
        review: "a different captured value",
      }),
    ]);

    expect(candidates).toHaveLength(0);
  });

  it("names a client-supplied scalar omitted by the later response", () => {
    const candidates = findings([
      request("write-1", 100, "POST", {
        id: "review-1",
        review: "Very happy indeed",
      }),
      response("write-1", 120, {
        id: "review-1",
        review: "Very happy indeed",
      }),
      request("read-1", 200, "GET"),
      response("read-1", 220, { id: "review-1" }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toContain("omitted the field");
    expect(candidates[0]?.title).toContain("review");
  });
});
