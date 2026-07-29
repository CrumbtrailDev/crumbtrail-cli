import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function detectors(events: BugEvent[]) {
  return buildEvidenceCandidates(events, { start: 0 }).map(
    (candidate) => candidate.detector,
  );
}

function request(
  t: number,
  requestId: string,
  signature: string,
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      requestId,
      method: "POST",
      url: "/api/payments/webhook",
      hdrs: { "x-payments-signature": signature },
    },
  } as unknown as BugEvent;
}

function response(t: number, requestId: string, status: number): BugEvent {
  return {
    t,
    k: "net.res",
    d: { requestId, st: status },
  } as unknown as BugEvent;
}

function paymentWrite(t: number, requestId: string): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "insert",
      table: "payments",
      requestId,
      after: { id: 1, status: "succeeded" },
    },
  } as unknown as BugEvent;
}

describe("payment boundary invariants", () => {
  it("flags a downstream success that completed after its caller timed out", () => {
    expect(
      detectors([
        {
          t: 100,
          k: "backend.http",
          d: {
            service: "payments",
            operation: "charge",
            method: "POST",
            url: "http://payments.internal/charge",
            status: 0,
            errorKind: "timeout",
            requestId: "checkout-1",
          },
        },
        {
          t: 101,
          k: "backend.otel.span",
          d: {
            name: "POST",
            serviceName: "shop-payments",
            requestId: "checkout-1",
            attributes: {
              "http.target": "/charge",
              "http.status_code": 200,
            },
          },
        },
      ] as unknown as BugEvent[]),
    ).toContain("downstream_succeeded_after_timeout");
  });

  it("does not equate a failed or unrelated downstream span with success", () => {
    const timeout = {
      t: 100,
      k: "backend.http",
      d: {
        service: "payments",
        url: "http://payments.internal/charge",
        status: 0,
        errorKind: "timeout",
        requestId: "checkout-1",
      },
    } as unknown as BugEvent;
    expect(
      detectors([
        timeout,
        {
          t: 101,
          k: "backend.otel.span",
          d: {
            serviceName: "shop-payments",
            requestId: "checkout-1",
            attributes: {
              "http.target": "/charge",
              "http.status_code": 504,
            },
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("downstream_succeeded_after_timeout");
    expect(
      detectors([
        timeout,
        {
          t: 101,
          k: "backend.otel.span",
          d: {
            serviceName: "shop-payments",
            requestId: "checkout-1",
            attributes: {
              "http.target": "/refund",
              "http.status_code": 200,
            },
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("downstream_succeeded_after_timeout");
    expect(
      detectors([
        timeout,
        {
          t: 101,
          k: "backend.otel.span",
          d: {
            serviceName: "shop-payments",
            requestId: "another-checkout",
            attributes: {
              "http.target": "/charge",
              "http.status_code": 200,
            },
          },
        },
      ] as unknown as BugEvent[]),
    ).not.toContain("downstream_succeeded_after_timeout");
  });

  it("flags a malformed SHA-256 webhook signature that still caused a write", () => {
    expect(
      detectors([
        request(100, "webhook-1", "sha256=deadbeef"),
        paymentWrite(110, "webhook-1"),
        response(120, "webhook-1", 200),
      ]),
    ).toContain("invalid_webhook_signature_accepted");
  });

  it("requires a malformed digest, a success response, and a correlated write", () => {
    const validDigest = `sha256=${"a".repeat(64)}`;
    expect(
      detectors([
        request(100, "webhook-1", validDigest),
        paymentWrite(110, "webhook-1"),
        response(120, "webhook-1", 200),
      ]),
    ).not.toContain("invalid_webhook_signature_accepted");
    expect(
      detectors([
        request(100, "webhook-1", "sha256=deadbeef"),
        paymentWrite(110, "webhook-1"),
        response(120, "webhook-1", 401),
      ]),
    ).not.toContain("invalid_webhook_signature_accepted");
    expect(
      detectors([
        request(100, "webhook-1", "sha256=deadbeef"),
        response(120, "webhook-1", 200),
      ]),
    ).not.toContain("invalid_webhook_signature_accepted");
  });
});
