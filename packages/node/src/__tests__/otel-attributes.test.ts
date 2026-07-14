import { describe, it, expect } from "vitest";
import {
  otlpValueToJs,
  attributesToMap,
  unixNanoToMillis,
} from "../otel-attributes";

describe("otel-attributes", () => {
  it("coerces OTLP scalar values", () => {
    expect(otlpValueToJs({ stringValue: "GET" })).toBe("GET");
    expect(otlpValueToJs({ boolValue: true })).toBe(true);
    expect(otlpValueToJs({ boolValue: false })).toBe(false);
    expect(otlpValueToJs({ intValue: "200" })).toBe(200);
    expect(otlpValueToJs({ doubleValue: 1.5 })).toBe(1.5);
    expect(otlpValueToJs(undefined)).toBeUndefined();
  });

  it("flattens nested array and kvlist values", () => {
    expect(
      otlpValueToJs({
        arrayValue: { values: [{ stringValue: "a" }, { intValue: 2 }] },
      }),
    ).toEqual(["a", 2]);
    expect(
      otlpValueToJs({
        kvlistValue: { values: [{ key: "k", value: { stringValue: "v" } }] },
      }),
    ).toEqual({ k: "v" });
  });

  it("builds a flat attribute map and skips keyless entries", () => {
    const attrs = [
      { key: "http.method", value: { stringValue: "POST" } },
      { key: "http.status_code", value: { intValue: "500" } },
      { value: { stringValue: "orphan" } },
    ];
    expect(attributesToMap(attrs)).toEqual({
      "http.method": "POST",
      "http.status_code": 500,
    });
    expect(attributesToMap(undefined)).toEqual({});
  });

  it("skips prototype pollution keys explicitly", () => {
    const attrs = [
      { key: "__proto__", value: { stringValue: "polluted" } },
      { key: "constructor", value: { stringValue: "polluted" } },
      { key: "prototype", value: { stringValue: "polluted" } },
      { key: "service.name", value: { stringValue: "checkout" } },
    ];

    const result = attributesToMap(attrs);

    expect(result).toEqual({ "service.name": "checkout" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("converts unix nanoseconds to milliseconds", () => {
    expect(unixNanoToMillis("1700000000000000000")).toBe(1700000000000);
    expect(unixNanoToMillis(undefined)).toBeUndefined();
    expect(unixNanoToMillis("not-a-number")).toBeUndefined();
  });
});
