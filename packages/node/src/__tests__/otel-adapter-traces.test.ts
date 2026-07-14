import { describe, it, expect } from "vitest";
import { convertOtlpTraceToEvents, OTEL_SPAN_EVENT } from "../otel-adapter";

describe("convertOtlpTraceToEvents", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  function payload(
    extraSpanAttrs: Array<{ key: string; value: { stringValue: string } }> = [],
  ) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: "00f067aa0ba902b7",
                  parentSpanId: "",
                  name: "POST /checkout",
                  kind: 2,
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000120000000",
                  status: { code: 2, message: "boom" },
                  attributes: [
                    { key: "http.method", value: { stringValue: "POST" } },
                    ...extraSpanAttrs,
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("maps a span into a BugEvent with the correlation bridge", () => {
    const [event] = convertOtlpTraceToEvents(payload());
    expect(event.k).toBe(OTEL_SPAN_EVENT);
    expect(event.t).toBe(1700000000000);
    expect(event.d.traceId).toBe(traceId);
    expect(event.d.requestId).toBe(traceId); // bridge to existing correlation
    expect(event.d.serviceName).toBe("api");
    expect(event.d.resourceAttributes).toEqual({ "service.name": "api" });
    expect(event.d.statusCode).toBe("ERROR");
    expect(event.d.durationMs).toBe(120);
    expect((event.d.attributes as Record<string, unknown>)["http.method"]).toBe(
      "POST",
    );
    expect(event.sessionId).toBeUndefined();
  });

  it("resolves sessionId from the crumbtrail.session.id span attribute", () => {
    const [event] = convertOtlpTraceToEvents(
      payload([
        { key: "crumbtrail.session.id", value: { stringValue: "sess-123" } },
      ]),
    );
    expect(event.sessionId).toBe("sess-123");
  });

  it("resolves sessionId from the resource attribute when absent on the span", () => {
    const p = payload();
    p.resourceSpans[0].resource.attributes.push({
      key: "crumbtrail.session.id",
      value: { stringValue: "sess-resource" },
    });
    const [event] = convertOtlpTraceToEvents(p);
    expect(event.sessionId).toBe("sess-resource");
    expect(event.d.resourceAttributes).toEqual({ "service.name": "api" });
  });

  it("returns an empty array for empty input", () => {
    expect(convertOtlpTraceToEvents(undefined)).toEqual([]);
    expect(convertOtlpTraceToEvents({})).toEqual([]);
  });
});
