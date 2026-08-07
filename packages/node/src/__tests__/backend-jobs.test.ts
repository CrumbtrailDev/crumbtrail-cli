import { describe, expect, it } from "vitest";
import {
  BACKEND_JOB_END_EVENT,
  BACKEND_JOB_ERROR_EVENT,
  BACKEND_JOB_START_EVENT,
  buildBackendJobEndEvent,
  buildBackendJobErrorEvent,
  buildBackendJobStartEvent,
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
} from "../backend-events";

describe("background job events", () => {
  it("names the job and the run", () => {
    const event = buildBackendJobStartEvent({
      name: "record-payment",
      jobId: "job_991",
      queue: "payments",
      attempt: 2,
      sessionId: "ses_1",
      requestId: "req_1",
    });

    expect(event.k).toBe(BACKEND_JOB_START_EVENT);
    expect(event.d).toMatchObject({
      job: "record-payment",
      jobId: "job_991",
      queue: "payments",
      attempt: 2,
      sessionId: "ses_1",
      requestId: "req_1",
    });
  });

  // The whole point. A job that lands in a parallel record nobody joins is not evidence about the
  // session the user was in.
  it("takes the correlation of the request that enqueued it", () => {
    const event = buildBackendJobStartEvent({
      name: "record-payment",
      headers: {
        [CRUMBTRAIL_SESSION_HEADER]: "ses_from_header",
        [CRUMBTRAIL_REQUEST_HEADER]: "req_from_header",
      },
    });

    expect(event.d).toMatchObject({
      sessionId: "ses_from_header",
      requestId: "req_from_header",
    });
    expect(event.sessionId).toBe("ses_from_header");
  });

  it("still records a job that carries no correlation, and says so", () => {
    const event = buildBackendJobStartEvent({ name: "nightly-reconcile" });

    expect(event.d.job).toBe("nightly-reconcile");
    expect((event.d.correlation as Record<string, unknown>).status).toBe(
      "missing-session-and-request-id",
    );
  });

  // `skipped` is the shape of work that was promised and never happened. Folding it into success
  // would hide the defect this capability exists to expose.
  it("keeps a skipped run distinct from a successful one", () => {
    const event = buildBackendJobEndEvent({
      name: "record-payment",
      outcome: "skipped",
      durationMs: 12,
      result: '{"reason":"no_matching_order","ordersSeen":0}',
    });

    expect(event.k).toBe(BACKEND_JOB_END_EVENT);
    expect(event.d).toMatchObject({ outcome: "skipped", durationMs: 12 });
    // Enum-shaped and numeric values survive the structured policy; free prose does not, exactly
    // as in a response body.
    expect(String(event.d.result)).toContain("no_matching_order");
    expect(String(event.d.result)).toContain("ordersSeen");
  });

  it("redacts a result under the same policy as a response body", () => {
    const event = buildBackendJobEndEvent({
      name: "record-payment",
      outcome: "success",
      result: JSON.stringify({ token: "hunter2-should-not-appear", count: 3 }),
    });

    expect(JSON.stringify(event.d)).not.toContain("hunter2-should-not-appear");
    expect(String(event.d.result)).toContain("3");
  });

  it("records a failure as a failure without being told", () => {
    const event = buildBackendJobErrorEvent({
      name: "record-payment",
      error: new TypeError("order not found"),
    });

    expect(event.k).toBe(BACKEND_JOB_ERROR_EVENT);
    expect(event.d.outcome).toBe("failure");
    expect(event.d.error).toMatchObject({
      name: "TypeError",
      message: "order not found",
    });
  });

  // A raw stack string never rests on an event; frames are structured or absent.
  it("never carries a raw stack string", () => {
    const event = buildBackendJobErrorEvent({
      name: "record-payment",
      error: new Error("boom"),
    });

    expect((event.d.error as Record<string, unknown>).stack).toBeUndefined();
  });
});
