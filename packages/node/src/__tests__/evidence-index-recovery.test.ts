import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function request(t: number, id: string, method: string, url: string): BugEvent {
  return { t, k: "net.req", d: { id, method, url } } as BugEvent;
}

function response(
  t: number,
  id: string,
  status: number,
  method: string,
  url: string,
): BugEvent {
  return {
    t,
    k: "net.res",
    d: { id, st: status, method, url },
  } as BugEvent;
}

function networkError(
  t: number,
  id: string,
  method: string,
  url: string,
): BugEvent {
  return {
    t,
    k: "net.err",
    d: { id, method, url, msg: "Failed to fetch" },
  } as BugEvent;
}

function networkIndex(
  t: number,
  id: string,
  method: string,
  url: string,
  end: number,
) {
  return {
    start: 900,
    end,
    networkErrors: [{ t, id, method, url, msg: "Failed to fetch" }],
  };
}

describe("buildEvidenceCandidates — failure recovery", () => {
  it("marks a recovered transport failure and does not emit a pending duplicate", () => {
    const failedUrl = "/api/cart?attempt=1";
    const retryUrl = "/api/cart?attempt=2";
    const candidates = buildEvidenceCandidates(
      [
        request(1000, "r1", "GET", failedUrl),
        networkError(1100, "r1", "GET", failedUrl),
        request(1110, "r2", "GET", retryUrl),
        response(1235, "r2", 200, "GET", retryUrl),
      ],
      networkIndex(1100, "r1", "GET", failedUrl, 1300),
    );

    const failure = candidates.find(
      (candidate) => candidate.detector === "network_error",
    );
    expect(failure).toMatchObject({
      recovery: { status: "recovered", afterMs: 135 },
      severity: "medium",
      score: 40,
    });
    expect(candidates.map((candidate) => candidate.detector)).toEqual([
      "network_error",
    ]);
  });

  it("marks a same-method, same-normalized-route retry as recovered and lowers severity", () => {
    const failedUrl = "https://service.example/api/orders/123?attempt=1";
    const retryUrl = "https://other.example/api/orders/456?attempt=2";
    const candidates = buildEvidenceCandidates(
      [
        request(1000, "r1", "POST", failedUrl),
        response(1050, "r1", 500, "POST", failedUrl),
        request(1100, "r2", "POST", retryUrl),
        response(1250, "r2", 200, "POST", retryUrl),
      ],
      {
        start: 900,
        end: 1300,
        failedReqs: [{ t: 1050, id: "r1", m: "POST", url: failedUrl, st: 500 }],
      },
    );

    const failure = candidates.find(
      (candidate) => candidate.detector === "http_error",
    );
    expect(failure).toMatchObject({
      recovery: { status: "recovered", afterMs: 200 },
      severity: "medium",
      score: 40,
    });
  });

  it("distinguishes a failure with no later equivalent success from an unknown future", () => {
    const failedUrl = "/api/cart?attempt=1";
    const failed = networkError(1100, "r1", "GET", failedUrl);

    const unrecovered = buildEvidenceCandidates(
      [
        failed,
        {
          t: 1200,
          k: "con",
          d: { lv: "warn", msg: "still on page" },
        } as BugEvent,
      ],
      networkIndex(1100, "r1", "GET", failedUrl, 1200),
    ).find((candidate) => candidate.detector === "network_error");
    expect(unrecovered).toMatchObject({
      recovery: { status: "not_recovered" },
      severity: "high",
      score: 86,
    });

    const endedAtFailure = buildEvidenceCandidates(
      [failed],
      networkIndex(1100, "r1", "GET", failedUrl, 1100),
    ).find((candidate) => candidate.detector === "network_error");
    expect(endedAtFailure).toMatchObject({
      recovery: { status: "unknown", reason: "session_ended" },
      severity: "high",
      score: 86,
    });
  });

  it("does not emit pending_request for a request that settled with a transport error", () => {
    const url = "/api/cart";
    const candidates = buildEvidenceCandidates(
      [networkError(1100, "r1", "GET", url)],
      networkIndex(1100, "r1", "GET", url, 1200),
    );

    expect(candidates.map((candidate) => candidate.detector)).toEqual([
      "network_error",
    ]);
  });
});
