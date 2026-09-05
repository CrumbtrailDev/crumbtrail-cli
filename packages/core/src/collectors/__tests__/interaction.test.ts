import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { BROWSER_REDACTION_POLICY, REDACTED_VALUE } from "../../redaction";
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

  // `matches` tested the exact event target, so a click on a button INSIDE an
  // ignored panel was captured with its full descriptor, and the input and
  // submit paths never consulted the list at all.
  it("skips everything inside an ignoreSelectors subtree", () => {
    cleanup();
    cleanup = interactionCollector(bus, {
      ...DEFAULT_CONFIG,
      ignoreSelectors: [".private-panel"],
    });
    bus.flush();
    events.length = 0;

    const panel = document.createElement("div");
    panel.className = "private-panel";
    panel.innerHTML =
      '<form id="pf"><button id="pay">Pay</button><input name="note"></form>';
    document.body.appendChild(panel);

    (panel.querySelector("#pay") as HTMLButtonElement).click();
    const input = panel.querySelector("input") as HTMLInputElement;
    input.value = "my private note about the failure";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (panel.querySelector("#pf") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true }),
    );
    bus.flush();

    expect(events).toHaveLength(0);

    document.body.removeChild(panel);
  });

  // Structural identifiers are exempt from text masking because a masked
  // selector correlates nothing — but a page that templates an address into an
  // id (`<tr id={`user-${email}`}>`) put it into the descriptor in clear.
  it("does not publish PII templated into an id or class", () => {
    const row = document.createElement("div");
    row.id = "user-alice@example.com";
    row.className = "row-4111111111111111";
    document.body.appendChild(row);

    row.click();
    bus.flush();

    const serialized = JSON.stringify(events.filter((e) => e.k === "clk"));
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("4111111111111111");

    document.body.removeChild(row);
  });

  // Over-redaction is its own bug: an ordinary id is the field that makes a
  // click correlatable at all.
  it("keeps an ordinary id and class verbatim", () => {
    const row = document.createElement("div");
    row.id = "user-12345-prefs";
    row.className = "list-row";
    document.body.appendChild(row);

    row.click();
    bus.flush();

    const el = events.filter((e) => e.k === "clk")[0].d.el as Record<
      string,
      unknown
    >;
    expect(el.id).toBe("user-12345-prefs");

    document.body.removeChild(row);
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

    // Free prose. The deny-biased classifier keeps numbers and short enum-like strings and redacts
    // everything else, so this is the redacted side of the same policy a request body answers to.
    input.value = "the totals looked wrong to me";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents).toHaveLength(1);
    expect(inpEvents[0].d.val).toBe(maskText("the totals looked wrong to me"));
    expect(inpEvents[0].d.valSummary).toMatchObject({
      kind: "input",
      action: "redacted",
      reason: "free_text_value",
    });
    expect(inpEvents[0].d.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        expect.objectContaining({
          path: "val",
          reason: "free_text_value",
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

  // `maskInputTypes` was read by the keystroke collector and by nothing else,
  // so a deployment that listed `number` — the default list does — got masked
  // keystrokes and the 2FA code itself in clear on the next `inp` event,
  // because the classifier keeps a number and never saw the setting.
  it("masks an input whose type is on maskInputTypes", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.name = "code";
    document.body.appendChild(input);

    input.value = "482913";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(JSON.stringify(inpEvents)).not.toContain("482913");
    expect(inpEvents[0].d.valSummary).toMatchObject({
      reason: "masked_input_type",
    });

    document.body.removeChild(input);
  });

  // Over-redaction is its own bug: a quantity is the evidence that explains a
  // pricing defect, and a type nobody asked to mask is still captured.
  it("keeps a value whose type is not on maskInputTypes", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.name = "quantity";
    document.body.appendChild(input);

    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    expect(events.filter((e) => e.k === "inp")[0].d.val).toBe("12");

    document.body.removeChild(input);
  });

  it("honours data-crumbtrail-unmask over maskInputTypes", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.setAttribute("data-crumbtrail-unmask", "");
    document.body.appendChild(input);

    input.value = "7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    expect(events.filter((e) => e.k === "inp")[0].d.val).toBe("7");

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

  it("captures controls cleared by a form remount after submit", () => {
    vi.useFakeTimers();
    const form = document.createElement("form");
    const line1 = document.createElement("input");
    line1.name = "line1";
    line1.value = "10 Downing Street";
    form.appendChild(line1);
    document.body.appendChild(form);

    form.dispatchEvent(new Event("submit", { bubbles: true }));
    form.remove();
    const replacementForm = document.createElement("form");
    const replacementLine1 = document.createElement("input");
    replacementLine1.name = "line1";
    replacementLine1.value = "";
    replacementForm.appendChild(replacementLine1);
    document.body.appendChild(replacementForm);
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

    document.body.removeChild(replacementForm);
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
      events.some((event) => event.k === "inp" && event.d.ev === "state"),
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

describe("click integrity", () => {
  // "The button does nothing" — the single most common support report a session
  // could not previously answer. An evaluation run scored exactly that case
  // WRONG, the judge noting the bundle showed only the ABSENCE of a request and
  // left the engineer to guess why the click produced nothing.
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (document as unknown as Record<string, unknown>).elementsFromPoint;
    document.body.innerHTML = "";
  });

  /**
   * jsdom implements no hit-testing at all, so the API this reads does not exist
   * here and the collector's optional call correctly yields nothing. Installing a
   * stub is what lets the behaviour be tested; that it is ABSENT in jsdom is
   * itself covered by the last case in this block.
   */
  const stubStack = (stack: Element[] | (() => never)) => {
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: typeof stack === "function" ? stack : () => stack,
    });
  };

  const clickOn = (element: Element, init: Partial<MouseEventInit> = {}) => {
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: 10,
        clientY: 20,
        ...init,
      }),
    );
    bus.flush();
    return events.find((event) => event.k === "clk");
  };

  it("records what was underneath the element that took the click", () => {
    // The decisive case: an overlay covers the button, so the overlay receives
    // the click and the button beneath it is never told. Without `covered` the
    // session shows a click and no request, which is indistinguishable from a
    // broken handler — and that ambiguity is what produced the wrong diagnosis.
    document.body.innerHTML =
      '<button id="checkout">Checkout</button><div id="overlay"></div>';
    const overlay = document.getElementById("overlay")!;
    const button = document.getElementById("checkout")!;
    stubStack([overlay, button, document.body]);

    const clk = clickOn(overlay);
    expect(clk).toBeDefined();
    const covered = clk!.d.covered as Array<Record<string, unknown>>;
    expect(covered).toBeDefined();
    expect(covered[0].tag).toBe("BUTTON");
    expect(clk!.d.targetNotInStack).toBeUndefined();
  });

  it("says so when the clicked element is not in its own hit-test stack", () => {
    // A control that re-rendered or detached between the click and the read.
    // "The target was gone" and "something covered it" call for different fixes,
    // so the record must not leave them looking the same.
    document.body.innerHTML =
      '<button id="gone">Gone</button><div id="other"></div>';
    const button = document.getElementById("gone")!;
    const other = document.getElementById("other")!;
    stubStack([other, document.body]);

    const clk = clickOn(button);
    expect(clk!.d.targetNotInStack).toBe(true);
    expect((clk!.d.covered as unknown[]).length).toBeGreaterThan(0);
  });

  it("adds nothing when the click landed on the topmost element", () => {
    // The ordinary case must stay cheap. Every byte here is paid on every click
    // of every session.
    document.body.innerHTML = '<button id="fine">Fine</button>';
    const button = document.getElementById("fine")!;
    stubStack([button]);

    const clk = clickOn(button);
    expect(clk!.d.covered).toBeUndefined();
    expect(clk!.d.deep).toBeUndefined();
  });

  it("adds no deep target when the composed path starts at the clicked element", () => {
    // The guard around the shadow-DOM branch, which is as much as this
    // environment can honestly show. In a browser a click inside a shadow root
    // is RETARGETED - `target` becomes the host, and only composedPath still
    // knows which control was pressed - but jsdom does not retarget, and
    // overriding composedPath is not a way around it: jsdom uses that same
    // method to compute propagation, so a stubbed path stops the event ever
    // reaching the listener. The retargeting branch is therefore exercised by
    // the browser-driven evaluation runs, not here.
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="inner">Save</button>';
    const inner = root.getElementById("inner")!;

    inner.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        composed: true,
        clientX: 1,
        clientY: 1,
      }),
    );
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(clk).toBeDefined();
    expect(clk!.d.deep).toBeUndefined();
  });

  it("survives a page that broke the DOM APIs it uses", () => {
    // Capture must never become the reason a click fails. Pages override these.
    document.body.innerHTML = '<button id="hostile">Go</button>';
    const button = document.getElementById("hostile")!;
    stubStack(() => {
      throw new Error("hostile page");
    });

    const clk = clickOn(button);
    expect(clk).toBeDefined();
    expect(clk!.d.covered).toBeUndefined();
  });
});

describe("interaction target accessible name", () => {
  // A signature path (`div[id]>div:nth-of-type(1)>...>button:nth-of-type(2)`)
  // cannot distinguish "clicked Next" from any other click. `el.label` is the
  // fix: the target's accessible name, resolved the way a screen reader would.
  //
  // Every case here runs against the real, unmodified DEFAULT_CONFIG: an
  // authored caption is not user content, so it survives
  // `maskAllText`/`maskAllInputs` on its own, and a test that had to defeat
  // masking to observe the field would be proving nothing about production.
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  const elOf = (event: BugEvent | undefined) =>
    event?.d.el as Record<string, unknown> | undefined;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("names a click target by its visible text, against the production default config", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = "<button>Next</button>";
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe("Next");
  });

  it("names a typed-into input by its placeholder", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = '<input placeholder="Preferred contact time">';
    const input = document.querySelector("input")!;
    input.value = "Sofia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe("Preferred contact time");
  });

  it("ships the fix plan's own example placeholder in full", () => {
    // "Search name, email or employee number" is the literal placeholder text
    // from the dogfood target app that motivated this feature (F4 in the fix
    // plan). The classifier's name-based deny check now runs against the
    // element's own `name`/`id` (there is none here), not the caption text,
    // so an ordinary word like "email" appearing INSIDE a caption no longer
    // gets treated as if the element were itself a field named `email` — a
    // caption is prose, not a field name. `redaction.denyFields` still
    // reaches caption content, via an explicit word match: see the
    // "denyFields" case below.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<input placeholder="Search name, email or employee number">';
    const input = document.querySelector("input")!;
    input.value = "Sofia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe(
      "Search name, email or employee number",
    );
  });

  it("still redacts a caption naming a PII-shaped field when the element itself is named that way", () => {
    // The element's OWN identifier (name/id), not the caption, is what feeds
    // the classifier's built-in sensitive-name check now. An element that is
    // actually named `email` still redacts its caption.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<input name="email" placeholder="Search name, email or employee number">';
    const input = document.querySelector("input")!;
    input.value = "Sofia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe(REDACTED_VALUE);
  });

  it("prefers an aria-label over the placeholder", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<input aria-label="Employee search" placeholder="Search name, email or employee number">';
    const input = document.querySelector("input")!;
    input.value = "Sofia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe("Employee search");
  });

  it("falls back to the title attribute when nothing else names the element", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<button title="Dismiss this notice"><svg></svg></button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe("Dismiss this notice");
  });

  it("names an input from its label[for]", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<label for="qty">Quantity</label><input id="qty">';
    const input = document.querySelector("input")!;
    input.value = "3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe("Quantity");
  });

  it("names an input from a wrapping label", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<label>Shipping speed <input id="speed"></label>';
    const input = document.querySelector("input")!;
    input.value = "Overnight";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe("Shipping speed");
  });

  it("excludes a wrapped select's option text from a wrapping label's name", () => {
    // A <label> wrapping a <select> would otherwise pick up every option's
    // text via textContent, leaking the unchosen options along with the
    // chosen one.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<label>Country <select id="country"><option value="ca">Canada</option><option value="us">United States</option></select></label>';
    const select = document.querySelector("select")!;
    select.value = "us";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe("Country");
  });

  it("does not use a wrapping label's text when the label itself is blocked", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<label data-crumbtrail-block>Shipping speed <input id="speed2"></label>';
    const input = document.querySelector("input")!;
    input.value = "Overnight";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBeUndefined();
  });

  it("does not use a label[for] source when that label sits inside a blocked subtree", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<div data-crumbtrail-block><label for="qty2">Quantity</label></div><input id="qty2">';
    const input = document.querySelector("input")!;
    input.value = "3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBeUndefined();
  });

  it("carries no name for a password field", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<input type="password" placeholder="Password" aria-label="Password" title="Password">';
    const input = document.querySelector("input")!;
    input.value = "hunter2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBeUndefined();
  });

  it("caps a long label at 40 characters", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    // Ordinary prose, not a token-shaped run: proves the cap without also
    // tripping the classifier's long-alnum-run heuristic.
    const long = "This label describes what the button does ".repeat(5);
    expect(long.length).toBeGreaterThan(200);
    document.body.innerHTML = `<button aria-label="${long}">go</button>`;
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toHaveLength(40);
    expect(elOf(clk)?.label).toBe(long.trim().slice(0, 40));
  });

  it("drops a name rather than ship a truncated fragment of an embedded email", () => {
    // The email sits past where a naive truncate-then-classify pipeline would
    // cut, so the old bug (classify AFTER truncating) would have shipped
    // "...accounting.dept@nort" in clear. Classifying the untruncated text
    // catches it; the name still must not leak a fragment, so it either
    // redacts outright or is dropped, never truncated into cleartext.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    const long =
      "Send the invoice to accounting.dept@northwind.example for review";
    expect(long.length).toBeGreaterThan(40);
    document.body.innerHTML = `<button aria-label="${long}">go</button>`;
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    const label = elOf(clk)?.label;
    expect(label === undefined || label === REDACTED_VALUE).toBe(true);
    expect(String(label ?? "")).not.toContain("accounting.dept@nort");
  });

  it("carries no name at all for an element marked data-crumbtrail-mask", () => {
    // The per-element escape hatch: an integration that wants a specific
    // caption kept out of capture regardless of the (survives-masking-by-
    // default) rule above.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = "<button data-crumbtrail-mask>Next</button>";
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBeUndefined();
  });

  it("carries no name at all for an element matched by ignoreSelectors", () => {
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      ignoreSelectors: [".no-capture"],
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = '<button class="no-capture">Next</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBeUndefined();
  });

  it("redacts a name that looks like a value, same as a captured input value", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<button aria-label="omar@example.com">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe(REDACTED_VALUE);
    expect(clk?.d.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
    });
  });

  it("redacts an email embedded in a longer caption, not just a whole-string email", () => {
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<button aria-label="Sign in as omar@example.com">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe(REDACTED_VALUE);
  });

  it("redacts a card number embedded in a title, never a digit fragment", () => {
    // Regression: a naive pipeline could ship "...ending in 4111 1111 1111"
    // (a truncated fragment still containing 12 of the 16 digits) if
    // classification ran after truncation. The digit run is caught by the
    // unanchored Luhn scan on the untruncated text, so the whole caption
    // redacts outright rather than being truncated into a partial number.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<a title="Payment method ending in 4111 1111 1111 1111"></a>';
    document.querySelector("a")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    const label = elOf(clk)?.label;
    expect(label === undefined || label === REDACTED_VALUE).toBe(true);
    expect(String(label ?? "")).not.toMatch(/\d{4}/);
  });

  it("ships a bracket-wrapped caption in full, with no redaction metadata", () => {
    // Regression: `redactNetworkTextBody`'s JSON sniff triggers on any
    // string whose first and last character are a matching bracket/brace,
    // regardless of the `contentType` passed to it. "[Draft]" is not valid
    // JSON, so `JSON.parse` used to throw inside that call and the text
    // plane pass came back with a "malformed_json_body" drop attached to
    // text nothing had actually inspected — shipping the caption in clear
    // while `el.redaction` falsely claimed a drop.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = '<button aria-label="[Draft]">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe("[Draft]");
    expect(clk?.d.redaction).toBeUndefined();
  });

  it("keeps a field named email when redaction.keepFields declares it", () => {
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      redaction: { ...DEFAULT_CONFIG.redaction, keepFields: ["email"] },
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<input name="email" placeholder="Search name, email or employee number">';
    const input = document.querySelector("input")!;
    input.value = "Sofia";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inp = events.find((e) => e.k === "inp");
    expect(elOf(inp)?.label).toBe(
      "Search name, email or employee number",
    );
  });

  it("suppresses a name matched by redaction.denyFields", () => {
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      redaction: { ...DEFAULT_CONFIG.redaction, denyFields: ["patient"] },
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<button aria-label="Patient Sofia Ramirez">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe(REDACTED_VALUE);
  });

  it("keeps an ordinary human-name caption when no denyFields match (accepted residual risk)", () => {
    // Documents the same tradeoff `ui-numbers.ts` accepts for rendered
    // labels: a caption that is itself PII but reads as ordinary free text
    // is indistinguishable from a benign caption, so it survives capture by
    // default. Mitigate with `redaction.denyFields`.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML = '<button aria-label="Sofia Ramirez">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe("Sofia Ramirez");
  });

  it("does not catch a spaced phone number, a dashed SSN-style run, or an IBAN embedded in a sentence (accepted residual risk)", () => {
    // Neither the text-plane pass (no colon/equals-delimited key, no URL, no
    // Bearer/JWT/hex/alnum-run token shape) nor the whole-string structured
    // classifier (none of these is the ENTIRE string, which is what the
    // anchored IBAN check and the deny-name checks require) catches these.
    // Documented here, and in the interaction.ts docblock and README, rather
    // than silently left uncovered.
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;

    document.body.innerHTML =
      '<button aria-label="Call me at 555 123 4567 about the order">go</button>';
    document.querySelector("button")!.click();
    bus.flush();

    const clk = events.find((e) => e.k === "clk");
    expect(elOf(clk)?.label).toBe(
      "Call me at 555 123 4567 about the order",
    );
  });
});
