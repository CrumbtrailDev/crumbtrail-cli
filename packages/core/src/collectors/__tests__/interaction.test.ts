import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { BROWSER_REDACTION_POLICY } from "../../redaction";
import { maskText } from "../../masking";
import {
  DEFAULT_CONFIG,
  type BugEvent,
  type CrumbtrailConfig,
} from "../../types";
import { interactionCollector } from "../interaction";

describe("interactionCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    // Flush and discard the initial nav event
    bus.flush();
    events.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // --- Initial nav ---
  it("emits initial nav event on setup", () => {
    cleanup();
    const initEvents: BugEvent[] = [];
    const initBus = new EventBus();
    initBus.subscribe((batch) => initEvents.push(...batch));
    const initCleanup = interactionCollector(initBus, DEFAULT_CONFIG);
    initBus.flush();

    expect(initEvents).toHaveLength(1);
    expect(initEvents[0].k).toBe("nav");
    expect(initEvents[0].d.tr).toBe("init");
    expect(initEvents[0].d.to).toBe(window.location.href);
    expect(initEvents[0].d.from).toBe("");

    initCleanup();
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });

  // --- Clicks ---
  it("captures click events with element descriptor", () => {
    const button = document.createElement("button");
    button.id = "submit-btn";
    button.textContent = "Submit";
    document.body.appendChild(button);

    button.click();
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("clk");
    expect(events[0].d.el).toEqual(
      expect.objectContaining({ tag: "BUTTON", id: "submit-btn" }),
    );
    expect(events[0].d.pos).toBeDefined();

    document.body.removeChild(button);
  });

  it("skips clicks on elements matching ignoreSelectors", () => {
    cleanup();
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      ignoreSelectors: [".ignored"],
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    const el = document.createElement("div");
    el.className = "ignored";
    document.body.appendChild(el);
    el.click();
    bus.flush();

    const clicks = events.filter((e) => e.k === "clk");
    expect(clicks).toHaveLength(0);

    document.body.removeChild(el);
  });

  it("uses configured safe descriptors and propagates descriptor redaction metadata", () => {
    cleanup();
    const descriptorRedaction = {
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        {
          path: "el.txt",
          reason: "element_text_too_long",
          action: "summarized" as const,
        },
      ],
    };
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      describeInteractionElement: () => ({
        tag: "BUTTON",
        selector: "#checkout",
        xpath: '//*[@id="checkout"]',
        redaction: descriptorRedaction,
      }),
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    const button = document.createElement("button");
    button.id = "checkout";
    document.body.appendChild(button);
    button.click();
    bus.flush();

    const click = events.find((event) => event.k === "clk");
    expect(click?.d.el).toMatchObject({
      selector: "#checkout",
      xpath: '//*[@id="checkout"]',
    });
    expect(click?.d.redaction).toEqual(descriptorRedaction);

    document.body.removeChild(button);
  });

  // --- Input ---
  it("captures input events with redacted value metadata", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.name = "username";
    document.body.appendChild(input);

    input.value = "alice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents).toHaveLength(1);
    expect(inpEvents[0].d.val).toBe(maskText("alice"));
    expect(inpEvents[0].d.valSummary).toMatchObject({
      kind: "input",
      action: "redacted",
      reason: "input_value",
    });
    expect(inpEvents[0].d.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        expect.objectContaining({
          path: "val",
          reason: "input_value",
          action: "redacted",
        }),
      ],
    });
    expect(inpEvents[0].d.ev).toBe("input");
    expect((inpEvents[0].d.el as Record<string, unknown>).name).toBe(
      "username",
    );

    document.body.removeChild(input);
  });

  it("masks password input values with sensitive redaction metadata", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    input.value = "secret123";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents[0].d.val).toBe(maskText("secret123"));
    expect(inpEvents[0].d.valSummary).toMatchObject({
      reason: "sensitive_input_value",
    });
    expect(JSON.stringify(inpEvents[0].d)).not.toContain("secret123");

    document.body.removeChild(input);
  });

  // --- Input trust ---
  it("marks a programmatic write to an input as untrusted", () => {
    const input = document.createElement("input");
    input.name = "quantity";
    document.body.appendChild(input);

    input.value = "99";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents).toHaveLength(1);
    expect(inpEvents[0].d.trusted).toBe(false);

    document.body.removeChild(input);
  });

  it("marks a user-generated input event as trusted", () => {
    const input = document.createElement("input");
    input.name = "quantity";
    document.body.appendChild(input);

    const event = new Event("input", { bubbles: true });
    Object.defineProperty(event, "isTrusted", { value: true });
    input.value = "2";
    input.dispatchEvent(event);
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents).toHaveLength(1);
    expect(inpEvents[0].d.trusted).toBe(true);

    document.body.removeChild(input);
  });

  it("marks form submits with their trust flag", () => {
    const form = document.createElement("form");
    document.body.appendChild(form);

    form.dispatchEvent(new Event("submit", { bubbles: true }));
    bus.flush();

    const submitEvents = events.filter(
      (e) => e.k === "inp" && e.d.ev === "submit",
    );
    expect(submitEvents).toHaveLength(1);
    expect(submitEvents[0].d.trusted).toBe(false);

    document.body.removeChild(form);
  });

  it("captures a silent programmatic value change after trusted input", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    input.name = "postalCode";
    document.body.appendChild(input);

    input.value = "SW1A2AA";
    const userInput = new Event("input", { bubbles: true });
    Object.defineProperty(userInput, "isTrusted", { value: true });
    input.dispatchEvent(userInput);
    input.value = "SWA";
    vi.advanceTimersByTime(450);
    bus.flush();

    const inputEvents = events.filter((event) => event.k === "inp");
    expect(inputEvents).toHaveLength(2);
    expect(inputEvents[1].d).toMatchObject({
      ev: "state",
      trusted: false,
      valSummary: { originalLength: 3 },
    });

    document.body.removeChild(input);
  });

  it("captures controls silently cleared after a form submit", () => {
    vi.useFakeTimers();
    const form = document.createElement("form");
    const line1 = document.createElement("input");
    line1.name = "line1";
    line1.value = "10 Downing Street";
    form.appendChild(line1);
    document.body.appendChild(form);

    form.dispatchEvent(new Event("submit", { bubbles: true }));
    line1.value = "";
    vi.advanceTimersByTime(700);
    bus.flush();

    expect(
      events.some(
        (event) =>
          event.k === "inp" &&
          event.d.ev === "state" &&
          event.d.trusted === false &&
          (event.d.el as Record<string, unknown>).name === "line1",
      ),
    ).toBe(true);

    document.body.removeChild(form);
  });

  it("does not report the user's next input as a silent overwrite", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    input.name = "postalCode";
    document.body.appendChild(input);

    for (const value of ["S", "SW"]) {
      input.value = value;
      const event = new Event("input", { bubbles: true });
      Object.defineProperty(event, "isTrusted", { value: true });
      input.dispatchEvent(event);
    }
    vi.advanceTimersByTime(450);
    bus.flush();

    expect(
      events.some(
        (event) => event.k === "inp" && event.d.ev === "state",
      ),
    ).toBe(false);

    document.body.removeChild(input);
  });

  // --- Navigation via pushState ---
  it("captures pushState navigation", () => {
    history.pushState({}, "", "/test-page");
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("push");
    expect(navEvents[0].d.to).toContain("/test-page");
  });

  it("captures replaceState navigation", () => {
    history.replaceState({}, "", "/replaced");
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("replace");
    expect(navEvents[0].d.to).toContain("/replaced");
  });

  it("captures a history pop as tr:'pop'", () => {
    history.pushState({}, "", "/step-two");
    bus.flush();
    events.length = 0;

    // The browser applies the traversal and then fires popstate; the collector
    // reads the destination off location, exactly as it does here.
    window.dispatchEvent(new Event("popstate"));
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("pop");
    expect(navEvents[0].d.to).toContain("/step-two");
  });

  it("captures a hash change as tr:'hash'", () => {
    window.dispatchEvent(new Event("hashchange"));
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("hash");
  });

  it("does not label a route change as an initial load", () => {
    history.pushState({}, "", "/somewhere");
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents.map((event) => event.d.tr)).not.toContain("init");
    expect(navEvents[0].d.navType).toBeUndefined();
  });

  // --- Document navigation type ---
  it("labels a back/forward document load on the initial nav event", () => {
    cleanup();
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { type: "back_forward" } as unknown as PerformanceEntry,
    ]);

    const initEvents: BugEvent[] = [];
    const initBus = new EventBus();
    initBus.subscribe((batch) => initEvents.push(...batch));
    const initCleanup = interactionCollector(initBus, DEFAULT_CONFIG);
    initBus.flush();

    expect(initEvents[0].d.tr).toBe("init");
    expect(initEvents[0].d.navType).toBe("back_forward");

    initCleanup();
    vi.restoreAllMocks();
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });

  it("omits navType when the Navigation Timing entry is unavailable", () => {
    cleanup();
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    const initEvents: BugEvent[] = [];
    const initBus = new EventBus();
    initBus.subscribe((batch) => initEvents.push(...batch));
    const initCleanup = interactionCollector(initBus, DEFAULT_CONFIG);
    initBus.flush();

    expect(initEvents[0].d.tr).toBe("init");
    expect(initEvents[0].d.navType).toBeUndefined();

    initCleanup();
    vi.restoreAllMocks();
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });

  // --- Cleanup ---
  it("restores history.pushState on cleanup", () => {
    cleanup();

    history.pushState({}, "", "/after-cleanup");
    bus.flush();
    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(0);

    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });
});
