import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { maskText } from "../masking";
import {
  interactionCollector,
  MAX_INERT_CLICKS,
} from "../collectors/interaction";

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function collect(config?: Partial<CrumbtrailConfig>) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = interactionCollector(bus, makeConfig(config));
  return { events, bus, cleanup };
}

describe("interactionCollector redaction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/start");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("redacts sensitive input values while preserving safe field context", () => {
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    const input = document.createElement("input");
    input.type = "password";
    input.name = "sessionPassword";
    input.value = "super-secret-password";
    document.body.appendChild(input);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inputEvent = events.find((event) => event.k === "inp");
    expect(inputEvent?.d).toMatchObject({
      val: maskText("super-secret-password"),
      ev: "input",
      valSummary: expect.objectContaining({
        kind: "input",
        reason: "sensitive_input_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(inputEvent)).not.toContain("super-secret-password");

    cleanup();
  });

  it("emits click, change, and submit events with safe element descriptors and no raw input values", () => {
    const { events, bus, cleanup } = collect({
      describeInteractionElement: (element) => ({
        tag: element.tagName,
        selector: 'form#checkout > input[name="cardNumber"]',
        value: "descriptor-secret",
        redaction: {
          policy: "crumbtrail.browser-redaction.v1",
          fields: [
            {
              path: "el.value",
              reason: "test_descriptor_redaction",
              action: "redacted",
            },
          ],
        },
      }),
    });
    bus.flush();
    events.length = 0;

    const form = document.createElement("form");
    form.id = "checkout";
    const input = document.createElement("input");
    input.name = "cardNumber";
    input.value = "4111111111111111";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Pay";
    form.append(input, button);
    document.body.appendChild(form);

    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 12, clientY: 34 }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    bus.flush();

    const clickEvent = events.find((event) => event.k === "clk");
    expect(clickEvent?.d).toMatchObject({
      pos: [12, 34],
      el: expect.objectContaining({
        tag: "BUTTON",
        selector: 'form#checkout > input[name="cardNumber"]',
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });

    const inputEvents = events.filter((event) => event.k === "inp");
    expect(inputEvents).toHaveLength(2);
    expect(
      inputEvents.find((event) => event.d.ev === "change")?.d,
    ).toMatchObject({
      val: maskText("4111111111111111"),
      valSummary: expect.objectContaining({
        kind: "input",
        reason: "sensitive_input_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(
      inputEvents.find((event) => event.d.ev === "submit")?.d,
    ).toMatchObject({
      val: "",
      el: expect.objectContaining({ tag: "FORM" }),
    });
    expect(JSON.stringify(events)).not.toContain("4111111111111111");

    cleanup();
  });

  it("emits navigation events with redacted URLs and safe frame context", () => {
    window.history.replaceState(null, "", "/start?token=secret#frag");
    const { events, bus, cleanup } = collect();
    bus.flush();

    const initNav = events.find(
      (event) => event.k === "nav" && event.d.tr === "init",
    );
    expect(initNav?.d).toMatchObject({
      from: "",
      to: "http://localhost:3000/start?token=[REDACTED;len=6;charset=alpha]",
      toOrigin: "http://localhost:3000",
      frame: expect.objectContaining({
        top: true,
        origin: "http://localhost:3000",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(initNav)).not.toContain("secret");
    expect(JSON.stringify(initNav)).not.toContain("#frag");

    events.length = 0;
    window.history.pushState(null, "", "/checkout?session=secret#pay");
    bus.flush();

    const pushNav = events.find(
      (event) => event.k === "nav" && event.d.tr === "push",
    );
    expect(pushNav?.d).toMatchObject({
      from: "http://localhost:3000/start?token=[REDACTED;len=6;charset=alpha]",
      to: "http://localhost:3000/checkout?session=[REDACTED;len=6;charset=alpha]",
      fromOrigin: "http://localhost:3000",
      toOrigin: "http://localhost:3000",
    });
    expect(JSON.stringify(pushNav)).not.toContain("secret");
    expect(JSON.stringify(pushNav)).not.toContain("#pay");

    cleanup();
  });
  // Geometry, not identity. The element stack alone cannot distinguish an overlay swallowing a
  // click from an ordinary ancestor sitting above a button; the size is what settles it. jsdom
  // does no layout, so both rects are stubbed — this asserts the capture and the arithmetic, not
  // a browser's measurement.
  it("captures the clicked element's viewport coverage", () => {
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    const overlay = document.createElement("div");
    overlay.id = "sp-offers-frame";
    document.body.appendChild(overlay);
    overlay.getBoundingClientRect = () =>
      ({ width: window.innerWidth, height: window.innerHeight }) as DOMRect;

    overlay.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    bus.flush();

    const clickEvent = events.find((event) => event.k === "clk");
    expect(clickEvent?.d.box).toMatchObject({
      w: window.innerWidth,
      h: window.innerHeight,
      viewportPct: 100,
    });

    cleanup();
  });

  // A rect that cannot be read must leave the field absent, never present a zero — "not measured"
  // and "measured as nothing" are opposite conclusions about an overlay.
  it("omits the box when the rect cannot be read", () => {
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    const button = document.createElement("button");
    document.body.appendChild(button);
    button.getBoundingClientRect = () => {
      throw new Error("detached");
    };

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    bus.flush();

    const clickEvent = events.find((event) => event.k === "clk");
    expect(clickEvent).toBeDefined();
    expect(clickEvent?.d.box).toBeUndefined();

    cleanup();
  });
});

/**
 * A disabled control receives no mousedown, no mouseup and no click — not on
 * itself and not on any ancestor — so the capture-phase click listener sees
 * nothing. Verified in Chrome against a disabled `<button>`: only `pointerdown`
 * and `pointerup` are dispatched, both targeting the disabled button itself.
 */
describe("interactionCollector inert clicks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function pointerPair(el: Element): void {
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        clientX: 7,
        clientY: 9,
      }),
    );
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        clientX: 7,
        clientY: 9,
      }),
    );
  }

  function clicks(events: BugEvent[]): BugEvent[] {
    return events.filter((event) => event.k === "clk");
  }

  it("records a press on a disabled button that the browser never turned into a click", () => {
    document.body.innerHTML = `<div class="toolbar"><button disabled>Next</button></div>`;
    const button = document.querySelector("button")!;
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    pointerPair(button);
    vi.advanceTimersByTime(1);
    bus.flush();

    const recorded = clicks(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].d.inert).toBe(true);
    expect(recorded[0].d.pos).toEqual([7, 9]);

    cleanup();
  });

  it("does not double-record an ordinary click that the browser did dispatch", () => {
    document.body.innerHTML = `<button>Next</button>`;
    const button = document.querySelector("button")!;
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    pointerPair(button);
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 7, clientY: 9 }),
    );
    vi.advanceTimersByTime(1);
    bus.flush();

    const recorded = clicks(events);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].d.inert).toBeUndefined();

    cleanup();
  });

  // A drag ends with a pointerup the browser also refuses to turn into a click.
  // Synthesizing one there would report a press that never happened.
  it("ignores a pointer pair that started on a different element", () => {
    document.body.innerHTML = `<button id="a">A</button><button id="b">B</button>`;
    const a = document.querySelector("#a")!;
    const b = document.querySelector("#b")!;
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    a.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
      }),
    );
    b.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        isPrimary: true,
      }),
    );
    vi.advanceTimersByTime(1);
    bus.flush();

    expect(clicks(events)).toHaveLength(0);

    cleanup();
  });

  it("drops a pending press when the gesture is cancelled", () => {
    document.body.innerHTML = `<button disabled>Next</button>`;
    const button = document.querySelector("button")!;
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    button.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
      }),
    );
    button.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    button.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        isPrimary: true,
      }),
    );
    vi.advanceTimersByTime(1);
    bus.flush();

    expect(clicks(events)).toHaveLength(0);

    cleanup();
  });

  it("stops synthesizing once the per-session ceiling is reached", () => {
    document.body.innerHTML = `<button disabled>Next</button>`;
    const button = document.querySelector("button")!;
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    for (let press = 0; press < MAX_INERT_CLICKS + 5; press += 1) {
      pointerPair(button);
      vi.advanceTimersByTime(1);
    }
    bus.flush();

    expect(clicks(events)).toHaveLength(MAX_INERT_CLICKS);

    cleanup();
  });
});
