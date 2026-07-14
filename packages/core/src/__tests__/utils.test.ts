import { describe, it, expect } from "vitest";
import {
  safeStringify,
  truncate,
  describeElement,
  generateSessionId,
  now,
} from "../utils";

describe("safeStringify", () => {
  it("serializes primitives", () => {
    expect(safeStringify("hello")).toBe('"hello"');
    expect(safeStringify(42)).toBe("42");
    expect(safeStringify(true)).toBe("true");
    expect(safeStringify(null)).toBe("null");
    expect(safeStringify(undefined)).toBe(undefined);
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = safeStringify(obj);
    expect(result).toContain("[Circular]");
    expect(result).toContain('"a":1');
  });

  it("respects depth limit", () => {
    const deep = { a: { b: { c: { d: "deep" } } } };
    const result = safeStringify(deep, 2);
    expect(result).toContain("[Object]");
    expect(result).not.toContain('"d"');
  });

  it("handles Error objects", () => {
    const err = new Error("test error");
    const result = safeStringify(err);
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe("Error");
    expect(parsed.message).toBe("test error");
    expect(parsed.stack).toBeDefined();
  });

  it("handles functions", () => {
    function myFn() {}
    const result = safeStringify({ fn: myFn });
    expect(result).toContain("[Function: myFn]");
  });

  it("handles arrays", () => {
    expect(safeStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles arrays beyond depth limit", () => {
    const result = safeStringify({ a: { b: [1, 2] } }, 1);
    expect(result).toContain("[Array(2)]");
  });

  it("handles symbols", () => {
    const result = safeStringify({ s: Symbol("test") });
    expect(result).toContain("Symbol(test)");
  });

  it("falls back to String() on complete failure", () => {
    const evil = {
      toJSON() {
        throw new Error("nope");
      },
      toString() {
        return "fallback";
      },
    };
    const result = safeStringify(evil);
    expect(typeof result).toBe("string");
  });
});

describe("truncate", () => {
  it("returns string unchanged if within limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("returns string unchanged if exactly at limit", () => {
    expect(truncate("12345", 5)).toBe("12345");
  });

  it("truncates at limit with no suffix", () => {
    expect(truncate("hello world", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("describeElement", () => {
  it("captures tag name", () => {
    const el = document.createElement("button");
    expect(describeElement(el).tag).toBe("BUTTON");
  });

  it("captures id when present", () => {
    const el = document.createElement("div");
    el.id = "main";
    expect(describeElement(el).id).toBe("main");
  });

  it("omits id when empty", () => {
    const el = document.createElement("div");
    expect(describeElement(el).id).toBeUndefined();
  });

  it("captures and truncates className to 200 chars", () => {
    const el = document.createElement("div");
    el.className = "a".repeat(300);
    const desc = describeElement(el);
    expect(desc.cls).toHaveLength(200);
  });

  it("captures and truncates text content to 100 chars", () => {
    const el = document.createElement("span");
    el.textContent = "x".repeat(200);
    const desc = describeElement(el);
    expect(desc.txt!.length).toBeLessThanOrEqual(100);
  });

  it("captures href for anchor elements", () => {
    const el = document.createElement("a");
    el.href = "https://example.com";
    expect(describeElement(el).href).toContain("example.com");
  });

  it("captures name and type for input elements", () => {
    const el = document.createElement("input");
    el.type = "email";
    el.name = "user-email";
    const desc = describeElement(el);
    expect(desc.name).toBe("user-email");
    expect(desc.type).toBe("email");
  });
});

describe("generateSessionId", () => {
  it("returns string matching ses_YYYYMMDD_HHmmss_random pattern", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^ses_\d{8}_\d{6}_[0-9a-f]{12}$/);
  });

  it("adds entropy across ids generated in the same second", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()));
    expect(ids.size).toBe(20);
  });

  it("fails closed when secure browser randomness is unavailable", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(() => generateSessionId()).toThrow("crypto.getRandomValues");
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("now", () => {
  it("returns current timestamp in ms", () => {
    const before = Date.now();
    const result = now();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});
