/**
 * Regression cover for the capture gap record itself.
 *
 * A gap exists to tell a reader that evidence was thrown away. A gap that
 * cannot say WHY is a gap that reads the same for "your ingest key is wrong",
 * "your batch is too big" and "you are being rate limited" — three different
 * things to do about it.
 */
import { describe, expect, it } from "vitest";

import { buildCaptureGapEvent } from "../capture-gap";
import type { CaptureGapEventData } from "../types";

function dataOf(event: ReturnType<typeof buildCaptureGapEvent>) {
  return event.d as unknown as CaptureGapEventData;
}

describe("buildCaptureGapEvent — delivery failure keeps its HTTP status", () => {
  for (const status of [401, 413, 429, 402, 500]) {
    it(`keeps "HTTP ${status}" in detail`, () => {
      const gap = buildCaptureGapEvent({
        surface: "browser",
        reason: "delivery_failed",
        detail: `HTTP ${status}`,
        droppedEventCount: 42,
      });

      expect(dataOf(gap).detail).toBe(`HTTP ${status}`);
      expect(dataOf(gap).droppedEventCount).toBe(42);
    });
  }

  it("distinguishes the statuses from one another", () => {
    const details = [401, 413, 429].map(
      (status) =>
        dataOf(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "delivery_failed",
            detail: `HTTP ${status}`,
          }),
        ).detail,
    );

    expect(new Set(details).size).toBe(3);
  });

  it("does not let arbitrary prose in through the HTTP classification", () => {
    const gap = buildCaptureGapEvent({
      surface: "browser",
      reason: "delivery_failed",
      detail: "HTTP 413 rejecting user bob@example.com at /api/orders/99887766",
    });

    const detail = dataOf(gap).detail ?? "";
    expect(detail).toContain("HTTP 413");
    expect(detail).not.toContain("bob@example.com");
    expect(detail).not.toContain("99887766");
    expect(detail).not.toContain("/api/orders");
  });

  it("ignores a status shaped run of digits that is not an HTTP status", () => {
    const gap = buildCaptureGapEvent({
      surface: "browser",
      reason: "delivery_failed",
      detail: "HTTP 9999",
    });

    expect(dataOf(gap).detail ?? "").not.toContain("HTTP");
  });
});

describe("CaptureGapEventData.reason covers both producers", () => {
  // The cloud edge writes capture gaps of its own on a shed, a rate limit or a
  // billing wall. Those reasons are part of this event's vocabulary whether or
  // not the browser SDK is the one that minted them; a union that omits them
  // makes every cloud authored gap a type error at the reader.
  const cloudAuthored = [
    "kill_switch",
    "sessions_per_hour",
    "bytes_per_day",
    "rate_limited_ingest",
    "rate_limited_session_start",
    "trial_expired",
    "payment_failed",
    "upgrade_required",
  ] as const satisfies readonly CaptureGapEventData["reason"][];

  for (const reason of cloudAuthored) {
    it(`accepts ${reason}`, () => {
      const gap = buildCaptureGapEvent({ surface: "browser", reason });
      expect(dataOf(gap).reason).toBe(reason);
      expect(dataOf(gap).kind).toBe("capture_gap");
    });
  }
});
