import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { postProcess } from "../post-process";

/**
 * The signal is only worth emitting if it survives to a reader. Two earlier
 * fields in this system — a request id source and a build identity — were
 * recorded correctly and carried nowhere, so the questions they answered could
 * only be settled by opening a raw session on disk.
 */
describe("credential presence reaches the session index", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "creds-index-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function indexFor(creds: unknown) {
    const events = [
      { t: 1000, k: "nav", d: { from: "", to: "/account", tr: "init" } },
      {
        t: 1100,
        k: "net.req",
        d: { id: 1, m: "GET", url: "/api/me", ...(creds ? { creds } : {}) },
      },
      { t: 1150, k: "net.res", d: { id: 1, m: "GET", url: "/api/me", st: 401 } },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    return JSON.parse(fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"));
  }

  it("carries presence from the request onto the failed request row", async () => {
    const index = await indexFor({ authorization: true, sessionCookie: false });
    expect(index.failedReqs[0].creds).toEqual({
      authorization: true,
      sessionCookie: false,
    });
  });

  it("carries an absence, which is the case the signal exists for", async () => {
    // Both false beside a 401 is the signed-out handshake: the client asking
    // whether anyone is logged in and being told no. That is the product's
    // designed behaviour, not a defect, and it is the most recurring "issue"
    // this product reports.
    const index = await indexFor({ authorization: false, sessionCookie: false });
    expect(index.failedReqs[0].creds).toEqual({
      authorization: false,
      sessionCookie: false,
    });
  });

  it("omits the field for a session recorded before it existed", async () => {
    const index = await indexFor(undefined);
    expect(index.failedReqs[0]).not.toHaveProperty("creds");
  });
});
