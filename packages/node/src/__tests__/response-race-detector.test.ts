import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function req(
  id: string | number,
  t: number,
  url: string,
  method = "GET",
): BugEvent {
  return { t, k: "net.req", d: { id, url, method } } as unknown as BugEvent;
}

function res(id: string | number, t: number, st = 200): BugEvent {
  return { t, k: "net.res", d: { id, st } } as unknown as BugEvent;
}

function detectors(events: BugEvent[]): string[] {
  return buildEvidenceCandidates(events, { start: 0 }).map((c) => c.detector);
}

function raceCandidate(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).find(
    (c) => c.detector === "response_race",
  );
}

/** Typed "de", then "desk"; the narrower query answers last. */
const RACED = [
  req("a", 100, "http://x/api/search?q=de"),
  req("b", 150, "http://x/api/search?q=desk"),
  res("b", 200),
  res("a", 400),
];

describe("response_race", () => {
  it("names two overlapping calls that returned out of order", () => {
    expect(detectors(RACED)).toContain("response_race");
  });

  it("stays silent when the same calls return in the order they were sent", () => {
    const events = [
      req("a", 100, "http://x/api/search?q=de"),
      req("b", 150, "http://x/api/search?q=desk"),
      res("a", 200),
      res("b", 400),
    ];
    expect(detectors(events)).not.toContain("response_race");
  });

  it("stays silent on sequential calls that never overlapped", () => {
    // Second request is issued only after the first has already answered, so
    // whichever lands last is also the newest — no race is possible.
    const events = [
      req("a", 100, "http://x/api/search?q=de"),
      res("a", 200),
      req("b", 300, "http://x/api/search?q=desk"),
      res("b", 400),
    ];
    expect(detectors(events)).not.toContain("response_race");
  });

  it("groups by path, so different endpoints are not a race with each other", () => {
    const events = [
      req("a", 100, "http://x/api/search?q=de"),
      req("b", 150, "http://x/api/products?q=desk"),
      res("b", 200),
      res("a", 400),
    ];
    expect(detectors(events)).not.toContain("response_race");
  });

  it("leaves failed responses to the error detectors", () => {
    const events = [
      req("a", 100, "http://x/api/search?q=de"),
      req("b", 150, "http://x/api/search?q=desk"),
      res("b", 200, 500),
      res("a", 400),
    ];
    expect(detectors(events)).not.toContain("response_race");
  });

  it("identifies both calls by send time, which redaction cannot blank", () => {
    // The query string is the only thing that differs between racing calls and
    // it is exactly what redaction removes, so the message has to stand on the
    // timing rather than on the URLs.
    const message = String(raceCandidate(RACED)?.anchor?.message ?? "");
    expect(message).toContain("+100 ms");
    expect(message).toContain("+150 ms");
    expect(message).toContain("200 ms after");
  });

  it("finds a race between two calls fired in the same millisecond", () => {
    // Two fetches from one tick share a timestamp, which is exactly what a real
    // per-keystroke race looks like. Comparing send times alone reads this as
    // "no race"; capture order is what records which actually went first.
    const events = [
      req("a", 34, "http://x/api/search?q=a"),
      req("b", 34, "http://x/api/search?q=sonar"),
      res("b", 45),
      res("a", 448),
    ];
    expect(detectors(events)).toContain("response_race");
  });

  it("reads the numeric request ids the browser SDK actually emits", () => {
    // The browser numbers its in-flight requests, so `d.id` is a number on every
    // browser captured session. Reading it as a string only ever matched the
    // backend fixtures, and left the request table empty for real sessions.
    const events = [
      req(1, 100, "http://x/api/search?q=de"),
      req(2, 150, "http://x/api/search?q=desk"),
      res(2, 200),
      res(1, 400),
    ];
    expect(detectors(events)).toContain("response_race");
  });

  it("does not assert the UI stomped, only that the ordering inverted", () => {
    const message = String(raceCandidate(RACED)?.anchor?.message ?? "");
    expect(message).toContain("unless it discards responses");
  });

  it("stays silent when identical polls swap order with identical responses", () => {
    // A build-check poller hitting the same URL on an interval: the two
    // overlapping fetches return the same 58-byte payload, so the page renders
    // the same thing in either order. This topped a live session's ranking.
    const body = { bodyMeta: { ct: "json", bytes: 58 } };
    const events = [
      req("a", 100, "http://x/build-id.json"),
      req("b", 150, "http://x/build-id.json"),
      { t: 200, k: "net.res", d: { id: "b", st: 200, ...body } },
      { t: 400, k: "net.res", d: { id: "a", st: 200, ...body } },
    ] as unknown as BugEvent[];
    expect(detectors(events)).not.toContain("response_race");
  });

  it("still reports an identical-URL race when the response sizes differ", () => {
    // Same cart endpoint fetched twice around a mutation: the payloads differ,
    // so whichever lands last decides what the user sees — a real race.
    const events = [
      req("a", 100, "http://x/api/cart"),
      req("b", 150, "http://x/api/cart"),
      { t: 200, k: "net.res", d: { id: "b", st: 200, bodyMeta: { ct: "json", bytes: 91 } } },
      { t: 400, k: "net.res", d: { id: "a", st: 200, bodyMeta: { ct: "json", bytes: 58 } } },
    ] as unknown as BugEvent[];
    expect(detectors(events)).toContain("response_race");
  });

  it("keeps the race when no response carries a size — suppression needs proof", () => {
    const events = [
      req("a", 100, "http://x/api/cart"),
      req("b", 150, "http://x/api/cart"),
      res("b", 200),
      res("a", 400),
    ];
    expect(detectors(events)).toContain("response_race");
  });

  it("reports nothing when two responses share one request id", () => {
    // The browser restarts its request counter on navigation, so a reload
    // replays id 1 and the second response joins the first request's record.
    // Send order does not exist for such a pair — a phantom race reported
    // from it anchored a live session's ranking with "+99 ms vs +99 ms".
    const events = [
      req(1, 100, "http://x/build-id.json"),
      req(1, 220, "http://x/build-id.json"),
      res(1, 230),
      res(1, 360),
    ];
    expect(detectors(events)).not.toContain("response_race");
  });
});
