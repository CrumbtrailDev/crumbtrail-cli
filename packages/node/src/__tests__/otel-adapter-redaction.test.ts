import { describe, expect, it } from "vitest";
import { REDACTED_VALUE } from "crumbtrail-core";
import {
  convertOtlpLogsToEvents,
  convertOtlpTraceToEvents,
} from "../otel-adapter";

describe("OTLP adapter redaction", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";
  const parentSpanId = "aabbccddeeff0011";
  const token = "sk_fake_abcdefghijklmnopqrstuvwxyz1234567890";

  it("redacts span attributes and status messages while preserving correlation fields", () => {
    const [event] = convertOtlpTraceToEvents({
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
                  spanId,
                  parentSpanId,
                  name: "POST /checkout",
                  status: {
                    code: 2,
                    message: `password=hunter2\ntoken=${token}`,
                  },
                  attributes: [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: "sess-secret-source" },
                    },
                    { key: "auth.token", value: { stringValue: token } },
                    { key: "db.password", value: { stringValue: "hunter2" } },
                    { key: "http.method", value: { stringValue: "POST" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(event.sessionId).toBe("sess-secret-source");
    expect(event.d.traceId).toBe(traceId);
    expect(event.d.spanId).toBe(spanId);
    expect(event.d.parentSpanId).toBe(parentSpanId);
    expect(event.d.requestId).toBe(traceId);

    const attrs = event.d.attributes as Record<string, unknown>;
    expect(attrs["crumbtrail.session.id"]).toBe(REDACTED_VALUE);
    expect(attrs["auth.token"]).toBe(REDACTED_VALUE);
    expect(attrs["db.password"]).toBe(REDACTED_VALUE);
    expect(attrs["http.method"]).toBe("POST");
    expect(event.d.statusMessage).toBe(
      `password=${REDACTED_VALUE}\ntoken=${REDACTED_VALUE}`,
    );
    expect(event.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
      fields: expect.arrayContaining([
        expect.objectContaining({
          path: "otel.span.attributes.auth.token",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.span.attributes.db.password",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.span.statusMessage.password",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.span.statusMessage.token",
          action: "redacted",
        }),
      ]),
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  it("redacts log attributes and bodies while preserving correlation fields", () => {
    const [event] = convertOtlpLogsToEvents({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000050000000",
                  traceId,
                  spanId,
                  severityText: "ERROR",
                  body: { stringValue: `password=hunter2\ntoken=${token}` },
                  attributes: [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: "sess-log-source" },
                    },
                    { key: "auth.token", value: { stringValue: token } },
                    { key: "db.password", value: { stringValue: "hunter2" } },
                    {
                      key: "log.message",
                      value: { stringValue: "safe detail" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(event.sessionId).toBe("sess-log-source");
    expect(event.d.traceId).toBe(traceId);
    expect(event.d.spanId).toBe(spanId);
    expect(event.d.requestId).toBe(traceId);

    const attrs = event.d.attributes as Record<string, unknown>;
    expect(attrs["crumbtrail.session.id"]).toBe(REDACTED_VALUE);
    expect(attrs["auth.token"]).toBe(REDACTED_VALUE);
    expect(attrs["db.password"]).toBe(REDACTED_VALUE);
    expect(attrs["log.message"]).toBe("safe detail");
    expect(event.d.body).toBe(
      `password=${REDACTED_VALUE}\ntoken=${REDACTED_VALUE}`,
    );
    expect(event.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
      fields: expect.arrayContaining([
        expect.objectContaining({
          path: "otel.log.attributes.auth.token",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.log.attributes.db.password",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.log.body.password",
          action: "redacted",
        }),
        expect.objectContaining({
          path: "otel.log.body.token",
          action: "redacted",
        }),
      ]),
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });
});
