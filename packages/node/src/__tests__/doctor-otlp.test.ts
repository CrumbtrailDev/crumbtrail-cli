import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { createServer } from "../server";
import { probeOtlpRoundTrip } from "../doctor";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("probeOtlpRoundTrip", () => {
  it("ingests an OTLP error span at /v1/traces and reads it back via MCP", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-doctor-otlp-"));
    const server: http.Server = createServer({ port: 0, outputDir: dir });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${addr.port}`;
    cleanups.push(() => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const res = await probeOtlpRoundTrip({
      endpoint,
      outputDir: dir,
      now: 1700000000000,
    });
    expect(res.ingested).toBe(true);
    expect(res.spanStatus).toBe("ERROR");
    expect(res.serviceName).toBe("crumbtrail-doctor");
    expect(res.spanCount).toBe(1);
  });
});
