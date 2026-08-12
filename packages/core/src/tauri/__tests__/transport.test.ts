import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { TauriTransport } from "../transport";

const mockedInvoke = vi.mocked(invoke);

describe("TauriTransport", () => {
  let transport: TauriTransport;

  beforeEach(() => {
    mockedInvoke.mockClear();
    transport = new TauriTransport();
  });

  it("startSession invokes plugin:crumbtrail|start_session", async () => {
    await transport.startSession("ses_20260328_101530", { app: "test" });

    expect(mockedInvoke).toHaveBeenCalledWith(
      "plugin:crumbtrail|start_session",
      {
        sessionId: "ses_20260328_101530",
        metadata: { app: "test" },
      },
    );
  });

  it("endSession invokes plugin:crumbtrail|end_session", async () => {
    await transport.endSession("ses_20260328_101530");

    expect(mockedInvoke).toHaveBeenCalledWith("plugin:crumbtrail|end_session", {
      sessionId: "ses_20260328_101530",
    });
  });

  it("sendEvents invokes plugin:crumbtrail|append_events with stored sessionId", async () => {
    await transport.startSession("ses_20260328_101530", {});
    mockedInvoke.mockClear();

    const events = [
      { t: 1000, k: "con", d: { level: "log", args: ["hello"] } },
      { t: 1001, k: "err", d: { msg: "fail" } },
    ];
    await transport.sendEvents(events);

    expect(mockedInvoke).toHaveBeenCalledWith(
      "plugin:crumbtrail|append_events",
      {
        sessionId: "ses_20260328_101530",
        events,
      },
    );
  });

  it("sendBlob converts Blob to number[] and invokes plugin:crumbtrail|write_blob", async () => {
    await transport.startSession("ses_20260328_101530", {});
    mockedInvoke.mockClear();

    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
    await transport.sendBlob("screenshot.png", blob, { frame: 1 });

    expect(mockedInvoke).toHaveBeenCalledWith("plugin:crumbtrail|write_blob", {
      sessionId: "ses_20260328_101530",
      name: "screenshot.png",
      data: [0x89, 0x50, 0x4e, 0x47],
      metadata: { frame: 1 },
    });
  });

  it("sendBlob passes empty object when metadata is undefined", async () => {
    await transport.startSession("ses_20260328_101530", {});
    mockedInvoke.mockClear();

    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    await transport.sendBlob("data.bin", blob);

    expect(mockedInvoke).toHaveBeenCalledWith("plugin:crumbtrail|write_blob", {
      sessionId: "ses_20260328_101530",
      name: "data.bin",
      data: [1, 2, 3],
      metadata: {},
    });
  });

  it("sessionId from startSession carries to subsequent calls", async () => {
    await transport.startSession("ses_first", {});
    mockedInvoke.mockClear();

    await transport.sendEvents([{ t: 1, k: "test", d: {} }]);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "plugin:crumbtrail|append_events",
      {
        sessionId: "ses_first",
        events: [{ t: 1, k: "test", d: {} }],
      },
    );

    // Start new session, verify sessionId updates
    await transport.startSession("ses_second", {});
    mockedInvoke.mockClear();

    await transport.sendEvents([{ t: 2, k: "test", d: {} }]);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "plugin:crumbtrail|append_events",
      {
        sessionId: "ses_second",
        events: [{ t: 2, k: "test", d: {} }],
      },
    );
  });

  it("sendBugReport invokes flag_bug and optional write_bug_voice", async () => {
    const report = {
      bugId: "bug_1",
      sessionId: "ses_1",
      flaggedAt: 1,
      windowMs: 1000,
      url: "http://localhost",
      userAgent: "test",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 1,
        eventKinds: { mark: 1 },
        durationMs: 0,
      },
    };
    const events = [{ t: 1, k: "mark", d: { label: "x" } }];
    const voiceBlob = new Blob([new Uint8Array([1, 2, 3])]);

    await transport.sendBugReport(report as any, events as any, voiceBlob);

    expect(mockedInvoke).toHaveBeenCalledWith("plugin:crumbtrail|flag_bug", {
      report,
      events,
    });
    expect(mockedInvoke).toHaveBeenCalledWith(
      "plugin:crumbtrail|write_bug_voice",
      {
        bugId: "bug_1",
        data: [1, 2, 3],
      },
    );
  });
});
