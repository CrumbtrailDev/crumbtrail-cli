import { describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  BACKEND_LOG_EVENT,
  buildBackendLogEvent,
  installBackendLogCapture,
  parseStructuredLogLine,
} from "../backend-logs";

/**
 * A stand-in writable stream shaped like `process.stdout`: the only member the
 * capture patches is `write`, and the fake records what the host wrote so the
 * tests can assert the host's own output is still delivered untouched.
 */
function fakeStream(): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  const stream = {
    written,
    write(chunk: unknown): boolean {
      written.push(String(chunk));
      return true;
    },
  };
  return stream as unknown as NodeJS.WriteStream & { written: string[] };
}

/** A pino line as pino actually writes it: NDJSON, numeric level, `err` object. */
function pinoLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    level: 50,
    time: 1_700_000_000_500,
    pid: 42,
    hostname: "api-1",
    reqId: "req-9",
    status: 503,
    err: {
      type: "Error",
      message: "keepa product lookup failed: upstream 429",
      stack:
        "Error: keepa product lookup failed: upstream 429\n    at fetchKeepaProduct (/app/src/services/keepa/fetchProduct.ts:68:11)\n    at async getProduct (/app/src/routes/product.ts:22:20)",
    },
    msg: "request failed",
    ...overrides,
  })}\n`;
}

describe("parseStructuredLogLine", () => {
  it("reads a pino error line: level, message, error and context fields", () => {
    const parsed = parseStructuredLogLine(pinoLine().trim());
    expect(parsed?.level).toBe("error");
    expect(parsed?.message).toBe("request failed");
    expect(parsed?.error?.name).toBe("Error");
    expect(parsed?.error?.message).toContain("upstream 429");
    expect(parsed?.error?.stack).toContain("fetchKeepaProduct");
    expect(parsed?.fields).toMatchObject({ status: 503, reqId: "req-9" });
    // Logger bookkeeping is not context a reader needs.
    expect(parsed?.fields).not.toHaveProperty("pid");
    expect(parsed?.fields).not.toHaveProperty("hostname");
    expect(parsed?.fields).not.toHaveProperty("time");
  });

  it("reads a winston line: string level and `message`", () => {
    const parsed = parseStructuredLogLine(
      JSON.stringify({
        level: "error",
        message: "payment capture failed",
        service: "api",
      }),
    );
    expect(parsed?.level).toBe("error");
    expect(parsed?.message).toBe("payment capture failed");
    expect(parsed?.fields).toMatchObject({ service: "api" });
  });

  it("maps bunyan/pino numeric levels onto names", () => {
    expect(parseStructuredLogLine('{"level":60,"msg":"down"}')?.level).toBe(
      "fatal",
    );
    expect(parseStructuredLogLine('{"level":40,"msg":"slow"}')?.level).toBe(
      "warn",
    );
    expect(parseStructuredLogLine('{"level":30,"msg":"hi"}')?.level).toBe(
      "info",
    );
  });

  it("ignores lines that are not structured logs", () => {
    expect(parseStructuredLogLine("Listening on :3000")).toBeUndefined();
    expect(parseStructuredLogLine("")).toBeUndefined();
    expect(parseStructuredLogLine("{not json")).toBeUndefined();
    // JSON without a level is some other program's output, not a log line.
    expect(parseStructuredLogLine('{"msg":"hello"}')).toBeUndefined();
    expect(parseStructuredLogLine("[1,2,3]")).toBeUndefined();
  });
});

describe("buildBackendLogEvent", () => {
  it("emits backend.log with the level, message, error and offset", () => {
    const event = buildBackendLogEvent(parseStructuredLogLine(pinoLine())!, {
      now: 1_700_000_000_500,
      sessionStartedAt: 1_700_000_000_000,
      sessionId: "sess_1",
    });
    expect(event.k).toBe(BACKEND_LOG_EVENT);
    expect(event.offsetMs).toBe(500);
    expect(event.sessionId).toBe("sess_1");
    expect(event.d.level).toBe("error");
    expect(event.d.message).toBe("request failed");
    expect((event.d.error as { stack?: string } | null)?.stack).toContain(
      "fetchKeepaProduct",
    );
  });

  it("redacts a token that a log line carried into the message", () => {
    const event = buildBackendLogEvent(
      parseStructuredLogLine(
        JSON.stringify({
          level: 50,
          // assembled so secret scanners do not flag the fixture as a real key
          msg: `auth failed for Bearer ${["sk", "live", "abcdefghijklmnopqrstuvwxyz012345"].join("_")}`,
          password: "hunter2",
        }),
      )!,
    );
    expect(String(event.d.message)).not.toContain(
      ["sk", "live", "abcdefghijklmnopqrstuvwxyz012345"].join("_"),
    );
    expect(
      JSON.stringify((event.d.fields as Record<string, unknown>) ?? {}),
    ).not.toContain("hunter2");
  });
});

describe("installBackendLogCapture", () => {
  it("captures a pino error written straight to stdout, with the app unchanged", () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout,
      stderr,
    });

    // Exactly what pino does: one NDJSON line, no console involved.
    stdout.write(pinoLine());

    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe(BACKEND_LOG_EVENT);
    expect(events[0].d.level).toBe("error");
    expect(String((events[0].d.error as { stack?: string }).stack)).toContain(
      "fetchKeepaProduct",
    );
    // The host's own logging is untouched.
    expect(stdout.written).toEqual([pinoLine()]);
  });

  it("ignores info and debug noise but keeps warn and above", () => {
    const stdout = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout,
      stderr: fakeStream(),
    });

    stdout.write('{"level":30,"msg":"listening"}\n');
    stdout.write('{"level":20,"msg":"cache hit"}\n');
    stdout.write('{"level":40,"msg":"retrying upstream"}\n');
    stdout.write('{"level":50,"msg":"upstream failed"}\n');
    handle.stop();

    expect(events.map((event) => event.d.level)).toEqual(["warn", "error"]);
  });

  it("reassembles a log line split across two writes", () => {
    const stdout = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout,
      stderr: fakeStream(),
    });

    stdout.write('{"level":50,"msg":"half a ');
    stdout.write('line"}\n');
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].d.message).toBe("half a line");
  });

  it("captures a line written through fs.write on fd 1 (pino's default transport)", () => {
    const events: BugEvent[] = [];
    const line = pinoLine();
    let wrote = "";
    const fsImpl = {
      write(fd: number, buffer: unknown, ...rest: unknown[]): unknown {
        wrote += String(buffer);
        void fd;
        void rest;
        return undefined;
      },
      writeSync(fd: number, buffer: unknown): number {
        wrote += String(buffer);
        void fd;
        return 0;
      },
    };

    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout: fakeStream(),
      stderr: fakeStream(),
      fsImpl: fsImpl as unknown as typeof import("node:fs"),
    });

    // SonicBoom (what `pino()` writes through by default) calls fs.write on the
    // raw file descriptor; process.stdout.write is never involved.
    fsImpl.writeSync(1, line);
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].d.level).toBe("error");
    expect(wrote).toBe(line);
  });

  it("never captures its own emit, however the sink logs", () => {
    const stdout = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => {
        events.push(event);
        // A sink that logs — the loop this guard exists to prevent.
        stdout.write('{"level":50,"msg":"sink said something"}\n');
      },
      stdout,
      stderr: fakeStream(),
    });

    stdout.write('{"level":50,"msg":"real failure"}\n');
    handle.stop();

    expect(events).toHaveLength(1);
    expect(events[0].d.message).toBe("real failure");
  });

  it("stops capturing after stop(), restoring the original write", () => {
    const stdout = fakeStream();
    const original = stdout.write;
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout,
      stderr: fakeStream(),
    });
    handle.stop();
    expect(stdout.write).toBe(original);

    stdout.write('{"level":50,"msg":"after stop"}\n');
    expect(events).toHaveLength(0);
  });

  it("shares one set of patches between two installs, and one event each", () => {
    const stdout = fakeStream();
    const first: BugEvent[] = [];
    const second: BugEvent[] = [];
    const original = stdout.write;
    const a = installBackendLogCapture({
      emit: (event) => first.push(event),
      stdout,
      stderr: fakeStream(),
    });
    const patchedOnce = stdout.write;
    const b = installBackendLogCapture({
      emit: (event) => second.push(event),
      stdout,
      stderr: fakeStream(),
    });
    // The second install reuses the first's patch rather than wrapping it.
    expect(stdout.write).toBe(patchedOnce);

    stdout.write('{"level":50,"msg":"one failure"}\n');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    // The patches survive until the LAST handle stops.
    a.stop();
    expect(stdout.write).toBe(patchedOnce);
    b.stop();
    expect(stdout.write).toBe(original);
  });

  it("holds a bounded budget so a log storm cannot flood ingest", () => {
    const stdout = fakeStream();
    const events: BugEvent[] = [];
    const handle = installBackendLogCapture({
      emit: (event) => events.push(event),
      stdout,
      stderr: fakeStream(),
      maxEvents: 3,
    });

    for (let i = 0; i < 10; i += 1) {
      stdout.write(`{"level":50,"msg":"failure ${i}"}\n`);
    }
    handle.stop();

    expect(events).toHaveLength(3);
  });
});
