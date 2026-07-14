import { describe, it, expect } from "vitest";
import { convertOtlpLogsToEvents, OTEL_LOG_EVENT } from "../otel-adapter";

describe("convertOtlpLogsToEvents", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  it("maps a log record into a BugEvent with the correlation bridge", () => {
    const events = convertOtlpLogsToEvents({
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
                  severityText: "ERROR",
                  severityNumber: 17,
                  body: { stringValue: "invalid password" },
                  traceId,
                  attributes: [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: "sess-9" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.k).toBe(OTEL_LOG_EVENT);
    expect(event.t).toBe(1700000000050);
    expect(event.d.body).toBe("invalid password");
    expect(event.d.severityText).toBe("ERROR");
    expect(event.d.serviceName).toBe("api");
    expect(event.d.resourceAttributes).toEqual({ "service.name": "api" });
    expect(event.d.requestId).toBe(traceId);
    expect(event.sessionId).toBe("sess-9");
  });

  it("falls back to observedTimeUnixNano when timeUnixNano is absent", () => {
    const events = convertOtlpLogsToEvents({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  observedTimeUnixNano: "1700000000999000000",
                  body: { stringValue: "fallback" },
                  attributes: [
                    {
                      key: "crumbtrail.session.id",
                      value: { stringValue: "sess-obs" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events[0].t).toBe(1700000000999);
    expect(events[0].sessionId).toBe("sess-obs");
  });

  it("resolves sessionId from the resource attribute when absent on the log", () => {
    const events = convertOtlpLogsToEvents({
      resourceLogs: [
        {
          resource: {
            attributes: [
              {
                key: "crumbtrail.session.id",
                value: { stringValue: "sess-resource-log" },
              },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1700000000050000000",
                  body: { stringValue: "hi" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events[0].sessionId).toBe("sess-resource-log");
  });

  it("returns an empty array for empty input", () => {
    expect(convertOtlpLogsToEvents(undefined)).toEqual([]);
    expect(convertOtlpLogsToEvents({})).toEqual([]);
  });
});
