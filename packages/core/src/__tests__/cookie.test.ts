import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { REDACTED_STORAGE_KEY, REDACTED_VALUE } from "../redaction";
import { cookieCollector } from "../collectors/cookie";

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("cookieCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    // Reset document.cookie — happy-dom allows direct assignment
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "",
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses document.cookie on init", () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "a=1; b=2",
      configurable: true,
    });

    const cleanup = cookieCollector(bus, makeConfig());
    bus.flush();

    const cookieEvents = events.filter((e) => e.k === "cookie");
    expect(cookieEvents).toHaveLength(2);
    expect(cookieEvents[0].d).toMatchObject({
      op: "set",
      name: "a",
      val: REDACTED_VALUE,
    });
    expect(cookieEvents[1].d).toMatchObject({
      op: "set",
      name: "b",
      val: REDACTED_VALUE,
    });
    expect(cookieEvents[0].d.redaction).toBeDefined();

    cleanup();
  });

  it("polling detects new cookies (set operation)", () => {
    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookiePollIntervalMs: 100 }),
    );
    bus.flush();
    events.length = 0; // clear init events

    // Simulate a new cookie appearing
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "newCookie=hello",
      configurable: true,
    });

    vi.advanceTimersByTime(100);
    bus.flush();

    const setEvents = events.filter(
      (e) => e.k === "cookie" && e.d.op === "set",
    );
    expect(setEvents).toHaveLength(1);
    expect(setEvents[0].d).toMatchObject({
      op: "set",
      name: "newCookie",
      val: REDACTED_VALUE,
    });

    cleanup();
  });

  it("polling detects deleted cookies (del operation)", () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "gone=value",
      configurable: true,
    });

    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookiePollIntervalMs: 100 }),
    );
    bus.flush();
    events.length = 0;

    // Cookie disappears
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "",
      configurable: true,
    });

    vi.advanceTimersByTime(100);
    bus.flush();

    const delEvents = events.filter(
      (e) => e.k === "cookie" && e.d.op === "del",
    );
    expect(delEvents).toHaveLength(1);
    expect(delEvents[0].d).toMatchObject({ op: "del", name: "gone" });

    cleanup();
  });

  it("polling detects modified cookies (mod operation)", () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "token=oldval",
      configurable: true,
    });

    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookiePollIntervalMs: 100 }),
    );
    bus.flush();
    events.length = 0;

    // Cookie value changes
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "token=newval",
      configurable: true,
    });

    vi.advanceTimersByTime(100);
    bus.flush();

    const modEvents = events.filter(
      (e) => e.k === "cookie" && e.d.op === "mod",
    );
    expect(modEvents).toHaveLength(1);
    expect(modEvents[0].d).toMatchObject({
      op: "mod",
      name: "token",
      val: REDACTED_VALUE,
    });

    cleanup();
  });

  it("masks cookie values when name is in cookieMaskNames", () => {
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "secret=topsecret; visible=ok",
      configurable: true,
    });

    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookieMaskNames: ["secret"] }),
    );
    bus.flush();

    const cookieEvents = events.filter((e) => e.k === "cookie");
    const secretEvent = cookieEvents.find((e) => e.d.name === "secret");
    const visibleEvent = cookieEvents.find((e) => e.d.name === "visible");

    expect(secretEvent!.d.val).toBe(REDACTED_VALUE);
    expect(secretEvent!.d.valSummary).toMatchObject({
      reason: "configured_cookie_mask",
    });
    expect(visibleEvent!.d.val).toBe(REDACTED_VALUE);

    cleanup();
  });

  it("sanitizes secret-bearing live cookie names", () => {
    const secretName = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: `${secretName}=topsecret`,
      configurable: true,
    });

    const cleanup = cookieCollector(bus, makeConfig());
    bus.flush();

    const cookieEvent = events.find((e) => e.k === "cookie");
    expect(cookieEvent?.d).toMatchObject({
      op: "set",
      name: REDACTED_STORAGE_KEY,
      val: REDACTED_VALUE,
    });
    expect(JSON.stringify(cookieEvent)).not.toContain(secretName);

    cleanup();
  });

  it("records oversized cookie value length without persisting the value", () => {
    const longValue = "x".repeat(100);
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: `big=${longValue}`,
      configurable: true,
    });

    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookieValueMaxLength: 10 }),
    );
    bus.flush();

    const cookieEvents = events.filter((e) => e.k === "cookie");
    expect(cookieEvents[0].d.val).toBe(REDACTED_VALUE);
    expect(cookieEvents[0].d.valSummary).toMatchObject({
      kind: "cookie",
      action: "redacted",
      originalLength: 100,
    });

    cleanup();
  });

  it("never persists cookie values from CookieStore changes", () => {
    const listeners: Array<(event: unknown) => void> = [];
    const mockCookieStore = {
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        if (type === "change") listeners.push(fn);
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("cookieStore", mockCookieStore);

    const cleanup = cookieCollector(bus, makeConfig());
    bus.flush();
    events.length = 0;

    for (const fn of listeners) {
      fn({
        changed: [
          {
            name: "session",
            value: "cookie-change-secret",
            secure: true,
            sameSite: "lax",
          },
        ],
        deleted: [],
      });
    }
    bus.flush();

    const cookieEvent = events.find((e) => e.k === "cookie");
    expect(cookieEvent?.d).toMatchObject({
      op: "set",
      name: "session",
      val: REDACTED_VALUE,
      valSummary: expect.objectContaining({
        kind: "cookie",
        reason: "cookie_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(cookieEvent)).not.toContain("cookie-change-secret");

    cleanup();
    vi.unstubAllGlobals();
  });

  it("sanitizes secret-bearing CookieStore change and delete names", () => {
    const listeners: Array<(event: unknown) => void> = [];
    const mockCookieStore = {
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        if (type === "change") listeners.push(fn);
      }),
      removeEventListener: vi.fn(),
    };
    const secretName = "session_token_abcdefghijklmnopqrstuvwxyz";

    vi.stubGlobal("cookieStore", mockCookieStore);
    const cleanup = cookieCollector(bus, makeConfig());
    bus.flush();
    events.length = 0;

    for (const fn of listeners) {
      fn({
        changed: [{ name: secretName, value: "cookie-change-secret" }],
        deleted: [{ name: secretName }],
      });
    }
    bus.flush();

    const serialized = JSON.stringify(events);
    expect(
      events.filter((e) => e.k === "cookie").map((event) => event.d.name),
    ).toEqual([REDACTED_STORAGE_KEY, REDACTED_STORAGE_KEY]);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain("cookie-change-secret");

    cleanup();
    vi.unstubAllGlobals();
  });

  it("cleanup clears poll interval", () => {
    const cleanup = cookieCollector(
      bus,
      makeConfig({ cookiePollIntervalMs: 100 }),
    );
    bus.flush();
    events.length = 0;

    cleanup();

    // Change cookie after cleanup — should not emit
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "after=cleanup",
      configurable: true,
    });

    vi.advanceTimersByTime(200);
    bus.flush();

    expect(events.filter((e) => e.k === "cookie")).toHaveLength(0);
  });

  it("uses CookieStore API listener when available", () => {
    // Mock the CookieStore API on globalThis
    const listeners: Array<(event: unknown) => void> = [];
    const mockCookieStore = {
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        if (type === "change") listeners.push(fn);
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("cookieStore", mockCookieStore);

    const cleanup = cookieCollector(bus, makeConfig());
    bus.flush();
    events.length = 0;

    // Simulate a CookieStore change event
    const changeEvent = {
      changed: [
        { name: "csapi", value: "val1", secure: true, sameSite: "strict" },
      ],
      deleted: [],
    };
    for (const fn of listeners) fn(changeEvent);

    bus.flush();

    const setEvents = events.filter(
      (e) => e.k === "cookie" && e.d.op === "set",
    );
    expect(setEvents).toHaveLength(1);
    expect(setEvents[0].d).toMatchObject({
      op: "set",
      name: "csapi",
      val: REDACTED_VALUE,
    });
    expect(setEvents[0].d.flags).toContain("s");
    expect(setEvents[0].d.flags).toContain("S");

    cleanup();
    expect(mockCookieStore.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    vi.unstubAllGlobals();
  });
});
