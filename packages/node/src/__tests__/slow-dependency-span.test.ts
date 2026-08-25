// A slow but SUCCESSFUL backend dependency has to become a ranked issue.
//
// Before this rule the OTLP plane ranked a span only when it failed, and both
// slowness rules read browser `net.res` events, so a 30 second database call
// that returned fine produced no candidate at all: the browser symptom was
// reported and the dependency that caused it was never named.

import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";

import { buildEvidenceCandidates } from "../evidence-index";

interface SpanOptions {
  t: number;
  spanId: string;
  name: string;
  durationMs: number;
  kind?: number;
  attributes?: Record<string, unknown>;
  statusCode?: string;
  traceId?: string;
}

function span(options: SpanOptions): BugEvent {
  const {
    t,
    spanId,
    name,
    durationMs,
    kind = 3,
    attributes,
    statusCode = "OK",
    traceId = "trace1",
  } = options;
  return {
    t,
    k: "backend.otel.span",
    d: {
      traceId,
      spanId,
      name,
      serviceName: "api",
      statusCode,
      kind,
      durationMs,
      ...(attributes ? { attributes } : {}),
    },
  };
}

function find(events: BugEvent[], detector: string) {
  return buildEvidenceCandidates(events, { start: 1_000 }).filter(
    (candidate) => candidate.detector === detector,
  );
}

const DB_ATTRS = { "db.system": "postgresql", "db.operation": "SELECT" };

describe("otel_slow_dependency", () => {
  it("ranks a slow database span that succeeded", () => {
    const found = find(
      [
        span({
          t: 1_100,
          spanId: "db1",
          name: "SELECT orders",
          durationMs: 30_000,
          attributes: DB_ATTRS,
        }),
      ],
      "otel_slow_dependency",
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].title).toContain("Slow database call");
    expect(found[0].title).toContain("30000 ms");
    expect(found[0].anchor.requestId).toBe("trace1");
  });

  it("ranks slow queue, cache and outbound HTTP calls the same way", () => {
    const events = [
      span({
        t: 1_100,
        spanId: "q1",
        name: "publish orders.created",
        durationMs: 8_000,
        kind: 4,
        attributes: { "messaging.system": "rabbitmq" },
      }),
      span({
        t: 1_200,
        spanId: "c1",
        name: "GET cart:42",
        durationMs: 9_000,
        attributes: { "db.system": "redis" },
      }),
      span({
        t: 1_300,
        spanId: "h1",
        name: "POST /charges",
        durationMs: 20_000,
        attributes: { "http.request.method": "POST" },
      }),
    ];
    const found = find(events, "otel_slow_dependency");
    expect(found.map((candidate) => candidate.title.split(":")[0]).sort()).toEqual([
      "Slow HTTP call",
      "Slow cache call",
      "Slow queue call",
    ]);
    // Only the 20 s outbound call clears the high severity floor.
    expect(
      found.filter((candidate) => candidate.severity === "high"),
    ).toHaveLength(1);
  });

  it("stays silent below the absolute floor when there is no distribution to compare with", () => {
    const found = find(
      [
        span({
          t: 1_100,
          spanId: "db1",
          name: "SELECT orders",
          durationMs: 4_000,
          attributes: DB_ATTRS,
        }),
      ],
      "otel_slow_dependency",
    );
    expect(found).toHaveLength(0);
  });

  it("leaves a failing span to otel_span_error rather than reporting it twice", () => {
    const events = [
      span({
        t: 1_100,
        spanId: "db1",
        name: "SELECT orders",
        durationMs: 30_000,
        statusCode: "ERROR",
        attributes: DB_ATTRS,
      }),
    ];
    expect(find(events, "otel_slow_dependency")).toHaveLength(0);
    expect(find(events, "otel_span_error")).toHaveLength(1);
  });

  it("does not restate a slow request as a slow span of its own", () => {
    // The SERVER span IS the request. Whatever reports that request as slow
    // already covers it, so ranking the span too would be the same finding
    // beside itself.
    const events = [
      span({
        t: 1_100,
        spanId: "srv1",
        name: "GET /orders",
        durationMs: 30_000,
        kind: 2,
        attributes: { "http.route": "/orders" },
      }),
    ];
    expect(find(events, "otel_slow_dependency")).toHaveLength(0);
  });

  it("ignores in process work, which is not an infrastructure dependency", () => {
    const events = [
      span({
        t: 1_100,
        spanId: "int1",
        name: "render report",
        durationMs: 30_000,
        kind: 1,
      }),
    ];
    expect(find(events, "otel_slow_dependency")).toHaveLength(0);
  });

  it("still ranks a database span from an exporter that sets no span kind", () => {
    const events: BugEvent[] = [
      {
        t: 1_100,
        k: "backend.otel.span",
        d: {
          traceId: "trace1",
          spanId: "db1",
          name: "SELECT orders",
          statusCode: "OK",
          durationMs: 30_000,
          attributes: DB_ATTRS,
        },
      },
    ];
    expect(find(events, "otel_slow_dependency")).toHaveLength(1);
  });

  it("stays silent on a span that carries no duration", () => {
    const events: BugEvent[] = [
      {
        t: 1_100,
        k: "backend.otel.span",
        d: {
          traceId: "trace1",
          spanId: "db1",
          name: "SELECT orders",
          statusCode: "OK",
          kind: 3,
          attributes: DB_ATTRS,
        },
      },
    ];
    expect(find(events, "otel_slow_dependency")).toHaveLength(0);
  });
});

describe("otel_dependency_latency_outlier", () => {
  const fast = (n: number) =>
    span({
      t: 1_100 + n * 10,
      spanId: `f${n}`,
      name: `SELECT item ${n}`,
      durationMs: 2,
      attributes: DB_ATTRS,
    });

  it("flags a dependency call far above the session's own median", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => fast(i)),
      span({
        t: 1_400,
        spanId: "slow1",
        name: "SELECT report",
        durationMs: 800,
        attributes: DB_ATTRS,
      }),
    ];
    const found = find(events, "otel_dependency_latency_outlier");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("800 ms");
    expect(found[0].title).toContain("400×");
    expect(found[0].severity).toBe("medium");
  });

  it("stays silent without enough calls to have a distribution", () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => fast(i)),
      span({
        t: 1_400,
        spanId: "slow1",
        name: "SELECT report",
        durationMs: 800,
        attributes: DB_ATTRS,
      }),
    ];
    expect(find(events, "otel_dependency_latency_outlier")).toHaveLength(0);
  });

  it("stays silent on a fast session, where a ratio is noise", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) =>
        span({
          t: 1_100 + i * 10,
          spanId: `f${i}`,
          name: `SELECT item ${i}`,
          durationMs: 0.1,
          attributes: DB_ATTRS,
        }),
      ),
      span({
        t: 1_400,
        spanId: "slow1",
        name: "SELECT report",
        durationMs: 4,
        attributes: DB_ATTRS,
      }),
    ];
    expect(find(events, "otel_dependency_latency_outlier")).toHaveLength(0);
  });

  it("leaves anything over the absolute floor to otel_slow_dependency", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => fast(i)),
      span({
        t: 1_400,
        spanId: "slow1",
        name: "SELECT report",
        durationMs: 6_000,
        attributes: DB_ATTRS,
      }),
    ];
    expect(find(events, "otel_dependency_latency_outlier")).toHaveLength(0);
    expect(find(events, "otel_slow_dependency")).toHaveLength(1);
  });
});
