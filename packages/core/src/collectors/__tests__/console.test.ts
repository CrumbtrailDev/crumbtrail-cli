import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { consoleCollector } from "../console";

describe("consoleCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = consoleCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  it('captures console.log with level "log"', () => {
    console.log("test message");
    bus.flush();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("con");
    expect(events[0].d.lv).toBe("log");
    expect(events[0].d.args).toEqual(['"test message"']);
    expect(events[0].t).toBeTypeOf("number");
  });

  it('captures console.warn with level "warn"', () => {
    console.warn("warning");
    bus.flush();
    expect(events[0].d.lv).toBe("warn");
  });

  it('captures console.error with level "err" and stack trace', () => {
    console.error("oops");
    bus.flush();
    expect(events[0].d.lv).toBe("err");
    expect(events[0].d.stk).toBeDefined();
    expect(events[0].d.stk).toContain("console.test.ts");
  });

  it('captures console.debug with level "dbg"', () => {
    console.debug("debug info");
    bus.flush();
    expect(events[0].d.lv).toBe("dbg");
  });

  it('captures console.info with level "info"', () => {
    console.info("info message");
    bus.flush();
    expect(events[0].d.lv).toBe("info");
  });

  it("serializes multiple arguments", () => {
    console.log("a", 42, true);
    bus.flush();
    expect(events[0].d.args).toEqual(['"a"', "42", "true"]);
  });

  it("redacts sensitive console arguments by default", () => {
    console.log(
      "login",
      { email: "ada@example.test", password: "hunter2" },
      "Authorization: Bearer abcdefghijklmnop",
    );
    bus.flush();

    const args = events[0].d.args as string[];
    expect(args.join(" ")).toContain("[REDACTED]");
    expect(args.join(" ")).not.toContain("hunter2");
    expect(args.join(" ")).not.toContain("ada@example.test");
    expect(args.join(" ")).not.toContain("abcdefghijklmnop");
    expect(events[0].d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
  });

  it("captures raw console arguments only when explicitly opted in", () => {
    cleanup();
    cleanup = consoleCollector(bus, {
      ...DEFAULT_CONFIG,
      captureRawConsole: true,
    });

    console.log({ password: "hunter2" });
    bus.flush();

    expect((events[0].d.args as string[])[0]).toContain("hunter2");
    expect(events[0].d.redaction).toBeUndefined();
  });

  it("handles non-serializable arguments gracefully", () => {
    const circular: Record<string, unknown> = { val: 1 };
    circular.self = circular;
    console.log(circular);
    bus.flush();
    expect(events).toHaveLength(1);
    expect((events[0].d.args as string[])[0]).toContain("[Circular]");
  });

  it("stops capturing after cleanup", () => {
    cleanup();
    console.log("after cleanup");
    bus.flush();
    expect(events).toHaveLength(0);
    cleanup = consoleCollector(bus, DEFAULT_CONFIG);
  });

  it("preserves original console behavior (no throw)", () => {
    expect(() => console.log("still works")).not.toThrow();
    expect(() => console.error("still works")).not.toThrow();
  });
});
