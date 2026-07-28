import { describe, it, expect } from "vitest";
import { bodyMetaFor, jsonResponse } from "./fixtures/net-res";

/**
 * Anti-drift pin. Every number asserted here is taken from the core suite's own
 * `net.res response body summary` expectations
 * (`packages/core/src/__tests__/network-response-body.test.ts`). If the emitter
 * changes, these fail here first, before the detector tests quietly start
 * describing a body shape the browser never sends.
 */
describe("net.res fixture mirrors the emitted bodyMeta contract", () => {
  it("summarizes a small JSON object the way the collector does", () => {
    const meta = bodyMetaFor({ total: 42, currency: "CAD" });
    expect(meta.ct).toBe("json");
    expect(meta.bytes).toBe(29);
    expect(meta.data).toEqual({ total: 42, currency: "CAD" });
    expect(meta.truncated).toBeUndefined();
    expect(meta.arrayTotal).toBeUndefined();
  });

  it("keys a truncated top-level array's true length under $", () => {
    const meta = bodyMetaFor(Array.from({ length: 25 }, (_, i) => i));
    expect(meta.data).toHaveLength(20);
    expect(meta.arrayTotal).toEqual({ $: 25 });
  });

  it("keys a truncated nested array's true length under its path", () => {
    const meta = bodyMetaFor({
      items: Array.from({ length: 57 }, (_, i) => i),
    });
    expect((meta.data as { items: number[] }).items).toHaveLength(20);
    expect(meta.truncated).toBe(true);
    expect(meta.arrayTotal).toEqual({ "$.items": 57 });
  });

  it("caps strings at 120 characters and marks the body truncated", () => {
    const meta = bodyMetaFor({
      note: "the quick brown fox jumps over the lazy dog. ".repeat(10),
      short: "ok",
    });
    const data = meta.data as { note: string; short: string };
    expect(data.note).toHaveLength(120);
    expect(data.short).toBe("ok");
    expect(meta.truncated).toBe(true);
    // A string cap says nothing about array lengths.
    expect(meta.arrayTotal).toBeUndefined();
  });

  it("caps nesting at four levels", () => {
    const meta = bodyMetaFor({ a: { b: { c: { d: { e: 1 } } } } });
    expect(meta.data).toEqual({ a: { b: { c: { d: "[object]" } } } });
    expect(meta.truncated).toBe(true);
  });

  it("keeps d.body a string alongside the summary", () => {
    const event = jsonResponse(10, "r", { total: 42 });
    expect(typeof event.d.body).toBe("string");
    expect(event.d.bodyMeta).toBeDefined();
  });
});
