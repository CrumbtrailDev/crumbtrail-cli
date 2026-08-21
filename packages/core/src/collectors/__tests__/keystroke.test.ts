import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import {
  DEFAULT_CONFIG,
  type BugEvent,
  type CrumbtrailConfig,
} from "../../types";
import { keystrokeCollector } from "../keystroke";

function dispatchKey(
  type: "keydown" | "keyup",
  init: KeyboardEventInit & { target?: EventTarget },
) {
  const event = new KeyboardEvent(type, { ...init, bubbles: true });
  if (init.target) {
    Object.defineProperty(event, "target", { value: init.target });
  }
  document.dispatchEvent(event);
}

describe("keystrokeCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = keystrokeCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  it("captures keydown events", () => {
    dispatchKey("keydown", { key: "a", code: "KeyA" });
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("key");
    expect(events[0].d.key).toBe("*");
    // Masked, so the class rather than the physical key (see the leak test below).
    expect(events[0].d.code).toBe("Letter");
    expect(events[0].d.dir).toBe("dn");
  });

  // A masked `key` is worth nothing if `code` still names the physical key:
  // `{key:"*",code:"KeyH"}{key:"*",code:"KeyU"}...` spells the password out, and
  // `mod:"s"` restores its capitalization. The assertion is on the whole
  // serialized event, not on a sibling field, because the tests above assert
  // `key === "*"` and never looked at `code`.
  it("leaves no trace of a masked character anywhere in the event", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    const typed: Array<[string, string]> = [
      ["h", "KeyH"],
      ["U", "KeyU"],
      ["n", "KeyN"],
      ["7", "Digit7"],
      ["!", "Digit1"],
    ];
    for (const [key, code] of typed) {
      dispatchKey("keydown", {
        key,
        code,
        target: input,
        shiftKey: key === "U" || key === "!",
      });
    }
    bus.flush();

    const serialized = JSON.stringify(events);
    for (const [, code] of typed) {
      expect(serialized).not.toContain(code);
    }
    expect(events).toHaveLength(typed.length);
    expect(events.map((event) => event.d.key)).toEqual([
      "*",
      "*",
      "*",
      "*",
      "*",
    ]);
    // The class survives, so the rhythm and shape of the entry stay readable
    // without the characters.
    expect(events.map((event) => event.d.code)).toEqual([
      "Letter",
      "Letter",
      "Letter",
      "Digit",
      "Digit",
    ]);

    input.remove();
  });

  // Navigation and control keys type no character, and they are the ones worth
  // reading `code` for: Tab order, Enter submitting a half-filled form.
  it("keeps the real code for keys that type nothing", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    dispatchKey("keydown", { key: "Tab", code: "Tab", target: input });
    dispatchKey("keydown", { key: "Enter", code: "Enter", target: input });
    dispatchKey("keydown", {
      key: "ArrowLeft",
      code: "ArrowLeft",
      target: input,
    });
    bus.flush();

    expect(events.map((event) => event.d.code)).toEqual([
      "Tab",
      "Enter",
      "ArrowLeft",
    ]);

    input.remove();
  });

  it("captures keyup events", () => {
    dispatchKey("keyup", { key: "a", code: "KeyA" });
    bus.flush();

    expect(events[0].d.dir).toBe("up");
  });

  it("captures modifier keys as compact string", () => {
    dispatchKey("keydown", {
      key: "c",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    bus.flush();

    expect(events[0].d.mod).toBe("cs");
  });

  it("omits mod field when no modifiers active", () => {
    dispatchKey("keydown", { key: "a", code: "KeyA" });
    bus.flush();

    expect(events[0].d.mod).toBeUndefined();
  });

  it("captures all modifier combinations", () => {
    dispatchKey("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: true,
    });
    bus.flush();

    expect(events[0].d.mod).toBe("csam");
  });

  it("computes inter-keystroke delta", () => {
    vi.useFakeTimers();

    dispatchKey("keydown", { key: "a", code: "KeyA" });
    vi.advanceTimersByTime(150);
    dispatchKey("keydown", { key: "b", code: "KeyB" });
    bus.flush();

    expect(events[0].d.dt).toBeUndefined();
    expect(events[1].d.dt).toBe(150);

    vi.useRealTimers();
  });

  it("masks key values for password fields", () => {
    const input = document.createElement("input");
    input.type = "password";

    dispatchKey("keydown", { key: "x", code: "KeyX", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
  });

  it("masks key values for sensitive input types by default", () => {
    const input = document.createElement("input");
    input.type = "email";

    dispatchKey("keydown", { key: "a", code: "KeyA", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
    expect(events[0].d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
  });

  it("masks key values for number inputs by default", () => {
    const input = document.createElement("input");
    input.type = "number";

    dispatchKey("keydown", { key: "4", code: "Digit4", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
  });

  it("masks key values for sensitive autocomplete hints", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("autocomplete", "one-time-code");

    dispatchKey("keydown", { key: "1", code: "Digit1", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
  });

  it("masks key values inside data-sensitive containers", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-sensitive", "true");
    const input = document.createElement("input");
    input.type = "text";
    wrapper.append(input);

    dispatchKey("keydown", { key: "s", code: "KeyS", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
  });

  it("masks key values for sensitive field names", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.name = "apiKey";

    dispatchKey("keydown", { key: "x", code: "KeyX", target: input });
    bus.flush();

    expect(events[0].d.key).toBe("*");
  });

  it("respects keystrokeThrottleMs for keyup events", () => {
    cleanup();
    vi.useFakeTimers();
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      keystrokeThrottleMs: 100,
    };
    cleanup = keystrokeCollector(bus, config);

    dispatchKey("keyup", { key: "a", code: "KeyA" });
    vi.advanceTimersByTime(50);
    dispatchKey("keyup", { key: "b", code: "KeyB" });
    bus.flush();

    const keyups = events.filter((e) => e.d.dir === "up");
    expect(keyups).toHaveLength(1);

    vi.useRealTimers();
  });

  it("always captures keydown regardless of throttle", () => {
    cleanup();
    vi.useFakeTimers();
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      keystrokeThrottleMs: 100,
    };
    cleanup = keystrokeCollector(bus, config);

    dispatchKey("keydown", { key: "a", code: "KeyA" });
    vi.advanceTimersByTime(10);
    dispatchKey("keydown", { key: "b", code: "KeyB" });
    bus.flush();

    const keydowns = events.filter((e) => e.d.dir === "dn");
    expect(keydowns).toHaveLength(2);

    vi.useRealTimers();
  });

  it("stops capturing after cleanup", () => {
    cleanup();
    dispatchKey("keydown", { key: "a", code: "KeyA" });
    bus.flush();
    expect(events).toHaveLength(0);
    cleanup = keystrokeCollector(bus, DEFAULT_CONFIG);
  });
});
