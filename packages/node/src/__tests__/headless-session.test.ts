import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server";
import { startHeadlessSession } from "../headless-session";

describe("startHeadlessSession", () => {
  it("starts, records, and finalizes a no-browser session through the server API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true, sessionId: "job-1" }), {
          status: 200,
        });
      },
    ) as unknown as typeof fetch;

    const session = await startHeadlessSession({
      endpoint: "http://127.0.0.1:9898/",
      sessionId: "job-1",
      authToken: "secret",
      metadata: {
        app: "billing-worker",
        release: "R182",
        job: "invoice-digest",
      },
      fetchImpl,
    });
    await session.record({
      t: 1000,
      k: "con",
      d: { lv: "info", msg: "started" },
    });
    await session.end();

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:9898/api/session/start",
      "http://127.0.0.1:9898/api/events",
      "http://127.0.0.1:9898/api/session/end",
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      sessionId: "job-1",
      metadata: {
        source: "headless",
        app: "billing-worker",
        release: "R182",
        job: "invoice-digest",
      },
    });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      sessionId: "job-1",
      events: [{ t: 1000, k: "con", d: { lv: "info", msg: "started" } }],
    });
    expect(calls[0]!.init.headers).toMatchObject({
      "x-crumbtrail-auth": "secret",
    });
  });

  it("surfaces server errors with a useful message", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Session already exists" }), {
          status: 409,
        }),
    ) as unknown as typeof fetch;

    await expect(
      startHeadlessSession({
        endpoint: "http://127.0.0.1:9898",
        sessionId: "job-1",
        fetchImpl,
      }),
    ).rejects.toThrow("Session already exists");
  });

  it("wraps non-JSON server errors with the response text", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream unavailable", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      startHeadlessSession({
        endpoint: "http://127.0.0.1:9898",
        sessionId: "job-1",
        fetchImpl,
      }),
    ).rejects.toThrow("upstream unavailable");
  });

  it("works against the real authenticated server and persists a finalized headless session", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-headless-"),
    );
    const outputDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(outputDir, { recursive: true });
    const server = createServer({
      port: 0,
      outputDir,
      authToken: "test-token",
      postProcess: async () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const address = server.address();
      if (!isTcpAddress(address))
        throw new Error("server did not bind to a TCP port");
      const session = await startHeadlessSession({
        endpoint: `http://127.0.0.1:${address.port}`,
        sessionId: "job-real",
        authToken: "test-token",
        metadata: { app: "billing-worker", source: "caller-value" },
      });
      await session.record({
        t: 1000,
        k: "con",
        d: { lv: "info", msg: "job started" },
      });
      await session.end();

      const sessionDir = findSessionDir(outputDir, "job-real");
      const meta = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8"),
      );
      const events = fs
        .readFileSync(path.join(sessionDir, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(meta).toMatchObject({
        id: "job-real",
        app: "billing-worker",
        source: "headless",
        processed: true,
      });
      expect(events).toEqual([
        expect.objectContaining({
          k: "con",
          d: { lv: "info", msg: "job started" },
        }),
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

function isTcpAddress(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return (
    address !== null &&
    typeof address === "object" &&
    typeof address.port === "number"
  );
}

function findSessionDir(outputDir: string, sessionId: string): string {
  const stack = [outputDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(dir, entry.name);
      if (
        entry.name === sessionId &&
        fs.existsSync(path.join(candidate, "meta.json"))
      )
        return candidate;
      stack.push(candidate);
    }
  }
  throw new Error(`session not found: ${sessionId}`);
}
