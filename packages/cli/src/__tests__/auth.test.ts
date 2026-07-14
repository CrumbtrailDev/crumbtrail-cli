import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authFilePath,
  clearAuth,
  ensureToken,
  loadAuth,
  loginBrowser,
  openBrowser,
  pkcePair,
  saveAuth,
} from "../auth";

// Cloud's CHALLENGE_RE — the challenge we send must satisfy it verbatim.
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

interface MockOptions {
  /** Token strings that GET /api/projects accepts (else 401). */
  validTokens?: Set<string>;
  /** #of device polls that return authorization_pending before success. */
  devicePendingPolls?: number;
  /** Token minted by exchange/device. */
  mintToken?: string;
}

interface MockServer {
  baseUrl: string;
  /** How many times the token exchange endpoint was hit. */
  exchanges: number;
  devicePolls: number;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function startMockCloud(opts: MockOptions = {}): Promise<MockServer> {
  const mintToken = opts.mintToken ?? "bl_cli_" + "a".repeat(48);
  let devicePolls = 0;
  let exchanges = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (opts.validTokens && opts.validTokens.has(token)) {
        return send(200, { projects: [] });
      }
      return send(401, { error: "unauthorized", code: "unauthorized" });
    }
    if (req.method === "POST" && url.pathname === "/api/cli/token") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.deviceCode) {
        devicePolls += 1;
        if (devicePolls <= (opts.devicePendingPolls ?? 0)) {
          return send(400, {
            error: "authorization pending",
            code: "authorization_pending",
          });
        }
        return send(200, {
          token: mintToken,
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }
      exchanges += 1;
      return send(200, { token: mintToken, expiresAt: "2099-01-01T00:00:00Z" });
    }
    if (req.method === "POST" && url.pathname === "/api/cli/device") {
      return send(201, {
        deviceCode: "dev-code-xyz",
        userCode: "ABCD-1234",
        verificationUri: `${server.baseUrlRef}/cli/activate`,
        expiresIn: 300,
        interval: 1,
      });
    }
    send(404, { error: "not found" });
  }) as http.Server & { baseUrlRef?: string };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  (server as http.Server & { baseUrlRef?: string }).baseUrlRef = baseUrl;
  return {
    baseUrl,
    get exchanges() {
      return exchanges;
    },
    get devicePolls() {
      return devicePolls;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

let tmpHome: string;
let env: NodeJS.ProcessEnv;
const silentUi = { out: () => {}, err: () => {} };

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), "bl-auth-"));
  // Isolate token storage AND enable browser viability on Linux (DISPLAY set).
  env = { ...process.env, XDG_CONFIG_HOME: tmpHome, DISPLAY: ":0" };
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("pkce", () => {
  it("produces a 43-char verifier and a matching S256 challenge", () => {
    for (let i = 0; i < 20; i++) {
      const { verifier, challenge } = pkcePair();
      expect(verifier).toHaveLength(43);
      expect(challenge).toMatch(CHALLENGE_RE);
      const recomputed = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      expect(recomputed).toBe(challenge);
    }
  });
});

function fakeChildProcess(): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = () => {};
  return ee;
}

describe("openBrowser (async spawn-failure detection)", () => {
  it("resolves false when the opener fails to spawn (async 'error', e.g. missing xdg-open)", async () => {
    const child = fakeChildProcess();
    const spawnFn = ((..._args: unknown[]) => {
      // The failure is only known asynchronously — exactly the ENOENT window
      // that a synchronous "assume success" would miss.
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    }) as unknown as Parameters<typeof openBrowser>[1];
    const opened = await openBrowser("https://example.com/authorize", spawnFn);
    expect(opened).toBe(false);
  });

  it("resolves true once the opener process actually spawns", async () => {
    const child = fakeChildProcess();
    const spawnFn = ((..._args: unknown[]) => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as Parameters<typeof openBrowser>[1];
    const opened = await openBrowser("https://example.com/authorize", spawnFn);
    expect(opened).toBe(true);
  });
});

describe("browser hand-off", () => {
  it("falls back to the device flow when the browser opener fails asynchronously", async () => {
    const mint = "bl_cli_" + "g".repeat(48);
    const mock = await startMockCloud({ mintToken: mint });
    // Resolves false only after a tick — proving the caller awaits the opener
    // instead of deciding synchronously (the CP4 review bug: a sync `!failed`
    // read before the child's `error` event ever fired).
    const openFn = async (_url: string): Promise<boolean> => {
      await new Promise((r) => setImmediate(r));
      return false;
    };
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      openFn,
      env,
      pollIntervalMs: 5,
    });
    expect(token).toBe(mint);
    expect(mock.devicePolls).toBeGreaterThan(0); // fell through to device flow
    await mock.close();
  });

  it("exchanges a callback code for a token stored 0600", async () => {
    const mint = "bl_cli_" + "b".repeat(48);
    const mock = await startMockCloud({ mintToken: mint });
    // openFn plays the browser: hit the localhost callback with a grant code.
    const openFn = (authorizeUrl: string): boolean => {
      const u = new URL(authorizeUrl);
      const port = u.searchParams.get("port");
      expect(u.searchParams.get("challenge")).toMatch(CHALLENGE_RE);
      http.get(`http://127.0.0.1:${port}/callback?code=grant-123`);
      return true;
    };

    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      openFn,
      env,
    });
    expect(token).toBe(mint);
    expect(mock.exchanges).toBe(1);

    // Persisted 0600.
    const file = authFilePath(env);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadAuth(env)?.token).toBe(mint);

    await mock.close();
  });
});

describe("browser hand-off deadline", () => {
  it("rejects with an actionable message when no approval arrives before the deadline", async () => {
    // Browser "opens" but the callback is never hit and no code is pasted, so
    // only the deadline racer can settle the race — mirroring loginDevice's
    // expiry. Without it, loginBrowser would hang forever.
    await expect(
      loginBrowser({
        base: "http://127.0.0.1:1", // never contacted; deadline fires first
        ui: silentUi,
        openFn: () => true,
        env,
        browserDeadlineMs: 25,
      }),
    ).rejects.toThrow(/run `crumbtrail login` again/);
  });
});

describe("device flow", () => {
  it("polls through authorization_pending to a token", async () => {
    const mint = "bl_cli_" + "c".repeat(48);
    const mock = await startMockCloud({
      devicePendingPolls: 2,
      mintToken: mint,
    });
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      noBrowser: true, // force device flow
      env,
      pollIntervalMs: 5,
    });
    expect(token).toBe(mint);
    expect(mock.devicePolls).toBe(3); // 2 pending + 1 success
    await mock.close();
  });
});

describe("env token (CRUMBTRAIL_TOKEN)", () => {
  it("accepts a valid CRUMBTRAIL_TOKEN, skips the login flow, and never persists it", async () => {
    const envToken = "bl_cli_" + "t".repeat(48);
    const mock = await startMockCloud({ validTokens: new Set([envToken]) });
    let opened = false;
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      env: { ...env, CRUMBTRAIL_TOKEN: envToken },
      openFn: () => {
        opened = true;
        return true;
      },
    });
    expect(token).toBe(envToken);
    // No interactive login was started.
    expect(opened).toBe(false);
    expect(mock.exchanges).toBe(0);
    expect(mock.devicePolls).toBe(0);
    // An env-provided credential isn't ours to cache.
    expect(loadAuth(env)).toBeUndefined();
    await mock.close();
  });

  it("fails fast when CRUMBTRAIL_TOKEN is set but the endpoint rejects it (401)", async () => {
    const mock = await startMockCloud({ validTokens: new Set(["good"]) });
    await expect(
      ensureToken({
        base: mock.baseUrl,
        ui: silentUi,
        env: { ...env, CRUMBTRAIL_TOKEN: "bl_cli_wrong" },
      }),
    ).rejects.toThrow(/CRUMBTRAIL_TOKEN.*rejected/i);
    // It never fell through to minting a token.
    expect(mock.exchanges).toBe(0);
    expect(mock.devicePolls).toBe(0);
    await mock.close();
  });
});

describe("non-TTY fail-fast", () => {
  it("refuses to start an interactive login when there's no token and no TTY", async () => {
    const noToken = { ...env };
    delete noToken.CRUMBTRAIL_TOKEN;
    await expect(
      ensureToken({
        // Never contacted — the guard fires before any network call.
        base: "http://127.0.0.1:1",
        ui: silentUi,
        env: noToken,
        allowInteractiveLogin: false,
      }),
    ).rejects.toThrow(/CRUMBTRAIL_TOKEN/);
  });

  it("still honors a valid cached token in a non-TTY shell (no login needed)", async () => {
    const stored = "bl_cli_" + "n".repeat(48);
    const mock = await startMockCloud({ validTokens: new Set([stored]) });
    saveAuth(
      {
        token: stored,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: mock.baseUrl,
      },
      env,
    );
    const noToken = { ...env };
    delete noToken.CRUMBTRAIL_TOKEN;
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      env: noToken,
      allowInteractiveLogin: false,
    });
    expect(token).toBe(stored);
    await mock.close();
  });
});

describe("token reuse + logout", () => {
  it("reuses a valid stored token without re-authenticating", async () => {
    const stored = "bl_cli_" + "d".repeat(48);
    saveAuth(
      { token: stored, expiresAt: "2099-01-01T00:00:00Z", endpoint: "" },
      env,
    );
    const mock = await startMockCloud({ validTokens: new Set([stored]) });
    // Fix the endpoint on the stored record to match the mock base.
    saveAuth(
      {
        token: stored,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: mock.baseUrl,
      },
      env,
    );

    let opened = false;
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      openFn: () => {
        opened = true;
        return true;
      },
      env,
    });
    expect(token).toBe(stored);
    expect(opened).toBe(false); // no re-auth
    expect(mock.exchanges).toBe(0);
    await mock.close();
  });

  it("clears an invalid stored token and re-logs in", async () => {
    const stale = "bl_cli_" + "e".repeat(48);
    const fresh = "bl_cli_" + "f".repeat(48);
    saveAuth(
      {
        token: stale,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: "PLACEHOLDER",
      },
      env,
    );
    const mock = await startMockCloud({ mintToken: fresh });
    // endpoint on record must match to attempt reuse; then /api/projects 401s it.
    saveAuth(
      {
        token: stale,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: mock.baseUrl,
      },
      env,
    );
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      noBrowser: true,
      env,
      pollIntervalMs: 5,
    });
    expect(token).toBe(fresh);
    expect(loadAuth(env)?.token).toBe(fresh);
    await mock.close();
  });

  it("logout deletes the auth file", () => {
    saveAuth({ token: "bl_cli_x", expiresAt: "x", endpoint: "x" }, env);
    expect(loadAuth(env)).toBeDefined();
    expect(clearAuth(env)).toBe(true);
    expect(loadAuth(env)).toBeUndefined();
    expect(clearAuth(env)).toBe(false); // already gone
  });
});
