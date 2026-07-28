import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  BACKEND_WARNING_EVENT,
  buildBackendWarningEvent,
  installBackendWarningCapture,
} from "../backend-warnings";

/**
 * A stand-in process. `process.on("warning")` is an EventEmitter channel and
 * nothing here needs a real process, so the tests drive a fake one and never
 * touch the runner's own warning stream.
 */
function fakeProcess(): NodeJS.Process & { emitWarning(w: Error): void } {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: (name: string) => emitter.listenerCount(name),
    emitWarning: (warning: Error) => emitter.emit("warning", warning),
  } as unknown as NodeJS.Process & { emitWarning(w: Error): void };
}

function warning(name: string, message: string, stack?: string): Error {
  const error = new Error(message);
  error.name = name;
  if (stack === undefined) delete (error as { stack?: string }).stack;
  else error.stack = stack;
  return error;
}

describe("buildBackendWarningEvent", () => {
  it("carries the warning name, message and first three stack lines", () => {
    const event = buildBackendWarningEvent(
      warning(
        "MaxListenersExceededWarning",
        "Possible EventEmitter memory leak detected. 11 close listeners added.",
        [
          "MaxListenersExceededWarning: Possible EventEmitter memory leak detected.",
          "    at _addListener (node:events:588:17)",
          "    at Server.addListener (node:events:606:10)",
          "    at Object.<anonymous> (/app/server.js:12:9)",
        ].join("\n"),
      ),
      { now: 1_700_000_000_500, sessionStartedAt: 1_700_000_000_000 },
    );

    expect(event.k).toBe(BACKEND_WARNING_EVENT);
    expect(event.t).toBe(1_700_000_000_500);
    expect(event.offsetMs).toBe(500);
    expect(event.d.name).toBe("MaxListenersExceededWarning");
    expect(event.d.message).toContain("11 close listeners added");
    expect(String(event.d.stack).split("\n")).toHaveLength(3);
    expect(String(event.d.stack)).not.toContain("/app/server.js");
  });

  it("reports a missing stack as null rather than omitting the field", () => {
    const event = buildBackendWarningEvent(
      warning("DeprecationWarning", "Buffer() is deprecated"),
    );
    expect(event.d).toHaveProperty("stack", null);
  });

  it("bounds the message at 300 characters", () => {
    // Ordinary prose, repeated: word breaks keep the shared token redactor out
    // of it, so what is measured here is the length bound and nothing else.
    const event = buildBackendWarningEvent(
      warning("DeprecationWarning", "the api is deprecated. ".repeat(60)),
    );
    expect(String(event.d.message)).toHaveLength(300);
  });

  it("falls back to a usable name for a warning that carries none", () => {
    const event = buildBackendWarningEvent({ message: "something happened" });
    expect(event.d.name).toBe("Warning");
  });

  it("redacts a token-like value the runtime happened to print", () => {
    const event = buildBackendWarningEvent(
      warning(
        "DeprecationWarning",
        "connection string sk_live_51H8xQ2eZvKYlo2CabcdefghijklmnopqrstuvwxYZ0123 is deprecated",
      ),
    );
    expect(String(event.d.message)).not.toContain(
      "sk_live_51H8xQ2eZvKYlo2CabcdefghijklmnopqrstuvwxYZ0123",
    );
  });
});

describe("installBackendWarningCapture", () => {
  it("emits a backend.warning event for a runtime warning", () => {
    const proc = fakeProcess();
    const events: BugEvent[] = [];
    const handle = installBackendWarningCapture({
      processImpl: proc,
      emit: (event) => events.push(event),
      sessionId: "ses_warn",
    });

    proc.emitWarning(warning("MaxListenersExceededWarning", "11 listeners"));

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe(BACKEND_WARNING_EVENT);
    expect(events[0].sessionId).toBe("ses_warn");
    handle.stop();
  });

  it("registers ONE process listener however many captures install", () => {
    const proc = fakeProcess();
    const first: BugEvent[] = [];
    const second: BugEvent[] = [];
    const a = installBackendWarningCapture({
      processImpl: proc,
      emit: (event) => first.push(event),
    });
    const b = installBackendWarningCapture({
      processImpl: proc,
      emit: (event) => second.push(event),
    });

    expect(proc.listenerCount("warning")).toBe(1);
    proc.emitWarning(warning("DeprecationWarning", "deprecated"));
    // One listener, but both installations are fed.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    a.stop();
    b.stop();
  });

  it("keeps the listener until the LAST installation stops", () => {
    const proc = fakeProcess();
    const first: BugEvent[] = [];
    const second: BugEvent[] = [];
    const a = installBackendWarningCapture({
      processImpl: proc,
      emit: (event) => first.push(event),
    });
    const b = installBackendWarningCapture({
      processImpl: proc,
      emit: (event) => second.push(event),
    });

    a.stop();
    expect(proc.listenerCount("warning")).toBe(1);
    proc.emitWarning(warning("DeprecationWarning", "deprecated"));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);

    b.stop();
    expect(proc.listenerCount("warning")).toBe(0);
    proc.emitWarning(warning("DeprecationWarning", "deprecated again"));
    expect(second).toHaveLength(1);
  });

  it("treats a repeated stop as a no-op", () => {
    const proc = fakeProcess();
    const a = installBackendWarningCapture({
      processImpl: proc,
      emit: () => {},
    });
    const b = installBackendWarningCapture({
      processImpl: proc,
      emit: () => {},
    });

    a.stop();
    a.stop();
    // The double stop must not have released b's claim.
    expect(proc.listenerCount("warning")).toBe(1);
    b.stop();
    expect(proc.listenerCount("warning")).toBe(0);
  });

  it("contains a throwing sink so capture cannot break the host", () => {
    const proc = fakeProcess();
    const handle = installBackendWarningCapture({
      processImpl: proc,
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    expect(() =>
      proc.emitWarning(warning("DeprecationWarning", "deprecated")),
    ).not.toThrow();
    handle.stop();
  });
});
