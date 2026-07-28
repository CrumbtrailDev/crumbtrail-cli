import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import { networkCollector } from "../collectors/network";
import { DEFAULT_CONFIG, type BugEvent, type CrumbtrailConfig } from "../types";

/**
 * `d.bodyMeta` is the bounded, parsed view of a response body. `d.body` keeps
 * its long-standing string contract; these tests pin both.
 */

const SAME_ORIGIN = "http://localhost:3000/api/cart";
const CROSS_ORIGIN = "https://api.example.com/cart";

function respondWith(
  body: string,
  contentType = "application/json",
  headers: Record<string, string> = {},
) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType, ...headers },
      }),
    ),
  );
}

function collect(overrides: Partial<CrumbtrailConfig> = {}) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = networkCollector(bus, { ...DEFAULT_CONFIG, ...overrides });
  return { events, bus, cleanup };
}

function bodyMetaOf(events: BugEvent[], bus: EventBus) {
  bus.flush();
  const res = events.find((event) => event.k === "net.res");
  return res?.d.bodyMeta as
    | {
        ct: string;
        bytes?: number;
        truncated?: boolean;
        data?: unknown;
        arrayTotal?: Record<string, number>;
      }
    | undefined;
}

describe("net.res response body summary", () => {
  let originalFetch: typeof globalThis.fetch;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("attaches a parsed summary for a same-origin JSON response", async () => {
    globalThis.fetch = respondWith('{"total":42,"currency":"CAD"}');
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.ct).toBe("json");
    expect(meta?.bytes).toBe(29);
    expect(meta?.data).toEqual({ total: 42, currency: "CAD" });
    expect(meta?.truncated).toBeUndefined();
  });

  it("leaves the response stream readable by the app", async () => {
    globalThis.fetch = respondWith('{"total":42}');
    const run = collect();
    cleanup = run.cleanup;

    const response = await globalThis.fetch(SAME_ORIGIN);
    await expect(response.json()).resolves.toEqual({ total: 42 });
  });

  it("truncates arrays past 20 items and records the true length", async () => {
    const items = Array.from({ length: 57 }, (_, index) => index);
    globalThis.fetch = respondWith(JSON.stringify({ items }));
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect((meta?.data as { items: number[] }).items).toHaveLength(20);
    expect(meta?.truncated).toBe(true);
    expect(meta?.arrayTotal).toEqual({ "$.items": 57 });
  });

  it("records the true length of a truncated top-level array", async () => {
    globalThis.fetch = respondWith(
      JSON.stringify(Array.from({ length: 25 }, (_, index) => index)),
    );
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.data).toHaveLength(20);
    expect(meta?.arrayTotal).toEqual({ $: 25 });
  });

  it("caps strings at 120 characters", async () => {
    globalThis.fetch = respondWith(
      JSON.stringify({
        note: "the quick brown fox jumps over the lazy dog. ".repeat(10),
        short: "ok",
      }),
    );
    const run = collect({ redaction: { keepFields: ["note", "short"] } });
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);
    const data = meta?.data as { note: string; short: string };

    expect(data.note).toHaveLength(120);
    expect(data.short).toBe("ok");
    expect(meta?.truncated).toBe(true);
  });

  it("caps nesting at four levels", async () => {
    globalThis.fetch = respondWith(
      JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } }),
    );
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.data).toEqual({ a: { b: { c: { d: "[object]" } } } });
    expect(meta?.truncated).toBe(true);
  });

  it("summarizes the redacted view, never the raw body", async () => {
    globalThis.fetch = respondWith(
      JSON.stringify({ password: "hunter2", total: 42 }),
    );
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);
    const data = meta?.data as { password: unknown; total: number };

    expect(JSON.stringify(data)).not.toContain("hunter2");
    expect(data.total).toBe(42);
  });

  it("attaches size facts only for a non-JSON response", async () => {
    globalThis.fetch = respondWith("<html></html>", "text/html; charset=utf-8");
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta).toEqual({ ct: "text/html", bytes: 13 });
  });

  it("attaches size facts only for a cross-origin JSON response", async () => {
    globalThis.fetch = respondWith('{"total":42}');
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(CROSS_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.ct).toBe("application/json");
    expect(meta?.data).toBeUndefined();
  });

  it("attaches size facts only when the JSON body is over 32KB", async () => {
    const big = JSON.stringify({ blob: "x".repeat(40_000) });
    globalThis.fetch = respondWith(big);
    const run = collect({ redaction: { keepFields: ["blob"] } });
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.bytes).toBeGreaterThan(32_768);
    expect(meta?.data).toBeUndefined();
  });

  it("attaches size facts only when the JSON does not parse", async () => {
    globalThis.fetch = respondWith('{"total":', "application/json");
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta?.ct).toBe("application/json");
    expect(meta?.data).toBeUndefined();
  });

  it("keeps d.body a string alongside the summary", async () => {
    globalThis.fetch = respondWith('{"total":42}');
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    run.bus.flush();
    const res = run.events.find((event) => event.k === "net.res");

    expect(typeof res?.d.body).toBe("string");
    expect(res?.d.bodyMeta).toBeDefined();
  });

  it("summarizes a binary response from its content-length", async () => {
    globalThis.fetch = respondWith("binary", "image/png", {
      "content-length": "20480",
    });
    const run = collect();
    cleanup = run.cleanup;

    await globalThis.fetch(SAME_ORIGIN);
    const meta = bodyMetaOf(run.events, run.bus);

    expect(meta).toEqual({ ct: "image/png", bytes: 20480 });
  });
});
