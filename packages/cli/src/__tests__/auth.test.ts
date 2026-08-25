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
  clearIdentityCache,
  clearReportedAppBases,
  reportedAppBase,
  describeIdentity,
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
  /**
   * How many of the FIRST device polls answer 429 with a Retry-After, the way
   * cloud's auth limiter does once the per-IP budget is spent.
   */
  deviceRateLimitedPolls?: number;
  /** Retry-After seconds sent with those 429s. */
  retryAfterSeconds?: number;
  /** Identity payload for GET /auth/me. */
  identity?: Record<string, unknown>;
  /**
   * Whether this origin serves the dashboard's sign-in pages (/cli/authorize,
   * /cli/activate). False plays a deployment that reports an API-only origin as
   * its dashboard — the shape that 404ed every sign-in link the CLI printed.
   */
  signInPages?: boolean;
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
  const mintToken = opts.mintToken ?? "ctcli_" + "a".repeat(48);
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
        if (devicePolls <= (opts.deviceRateLimitedPolls ?? 0)) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": String(opts.retryAfterSeconds ?? 1),
          });
          return res.end(
            JSON.stringify({
              error: "Too many authentication attempts",
              code: "rate_limited",
            }),
          );
        }
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
    if (req.method === "GET" && url.pathname === "/auth/me") {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (opts.validTokens && !opts.validTokens.has(token)) {
        return send(401, { error: "unauthorized", code: "unauthorized" });
      }
      return send(200, opts.identity ?? { userId: "usr_1", tenantId: "ten_1" });
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
    if (
      req.method === "GET" &&
      (url.pathname === "/cli/authorize" || url.pathname === "/cli/activate")
    ) {
      if (opts.signInPages === false) return send(404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<!doctype html><title>Crumbtrail</title>");
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
    const mint = "ctcli_" + "g".repeat(48);
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
    const mint = "ctcli_" + "b".repeat(48);
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

describe("sign-in links land on the dashboard, not the API host", () => {
  it("opens /cli/authorize on the dashboard origin, not the API base", async () => {
    const mint = "ctcli_" + "c".repeat(48);
    // Two origins, the way the hosted deployment is split: api.* answers the
    // CLI, app.* serves the SPA that /cli/authorize lives in.
    const api = await startMockCloud({ mintToken: mint, signInPages: false });
    const app = await startMockCloud({ mintToken: mint });
    let openedUrl = "";
    const openFn = (authorizeUrl: string): boolean => {
      openedUrl = authorizeUrl;
      const port = new URL(authorizeUrl).searchParams.get("port");
      http.get(`http://127.0.0.1:${port}/callback?code=grant-123`);
      return true;
    };
    const token = await ensureToken({
      base: api.baseUrl,
      ui: silentUi,
      openFn,
      env: { ...env, CRUMBTRAIL_APP_URL: app.baseUrl },
    });
    expect(token).toBe(mint);
    expect(openedUrl.startsWith(`${app.baseUrl}/cli/authorize?`)).toBe(true);
    // The token exchange still went to the API base, not the dashboard.
    expect(api.exchanges).toBe(1);
    expect(app.exchanges).toBe(0);
    await api.close();
    await app.close();
  });

  // Without this the browser hand-off was the ONE flow that ignored what the
  // deployment had already said about itself: it derived the authorize URL from
  // the API base, 404-probed it, and silently dropped to device code on every
  // split-origin self-host that had not set CRUMBTRAIL_APP_URL.
  it("uses the dashboard origin a previous login stored, with no env override", async () => {
    const mint = "ctcli_" + "g".repeat(48);
    const api = await startMockCloud({ mintToken: mint, signInPages: false });
    const app = await startMockCloud({ mintToken: mint });
    // A stale cached token for this endpoint: not accepted, so the run has to
    // log in again — but it carries the dashboard origin from the login before.
    saveAuth(
      {
        token: "ctcli_" + "z".repeat(48),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        endpoint: api.baseUrl,
        appBaseUrl: app.baseUrl,
      },
      env,
    );
    let openedUrl = "";
    const openFn = (authorizeUrl: string): boolean => {
      openedUrl = authorizeUrl;
      const port = new URL(authorizeUrl).searchParams.get("port");
      http.get(`http://127.0.0.1:${port}/callback?code=grant-123`);
      return true;
    };
    const token = await ensureToken({
      base: api.baseUrl,
      ui: silentUi,
      openFn,
      env,
    });
    expect(token).toBe(mint);
    expect(openedUrl.startsWith(`${app.baseUrl}/cli/authorize?`)).toBe(true);
    await api.close();
    await app.close();
  });

  it("does not open a sign-in page that 404s — it falls back to the device flow", async () => {
    const mint = "ctcli_" + "d".repeat(48);
    const mock = await startMockCloud({ mintToken: mint, signInPages: false });
    let opened = false;
    const openFn = (): boolean => {
      opened = true;
      return true;
    };
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      openFn,
      env,
      pollIntervalMs: 5,
    });
    expect(token).toBe(mint);
    expect(opened).toBe(false); // never sent to a 404
    expect(mock.devicePolls).toBeGreaterThan(0);
    await mock.close();
  });

  it("warns, instead of going quiet, when the device page 404s", async () => {
    const mint = "ctcli_" + "e".repeat(48);
    const mock = await startMockCloud({ mintToken: mint, signInPages: false });
    const lines: string[] = [];
    const ui = { out: (l: string) => lines.push(l), err: () => {} };
    const token = await ensureToken({
      base: mock.baseUrl,
      ui,
      openFn: () => false,
      env,
      pollIntervalMs: 5,
    });
    expect(token).toBe(mint);
    const printed = lines.join("\n");
    expect(printed).toContain("returns 404");
    expect(printed).toContain("CRUMBTRAIL_APP_URL");
    await mock.close();
  });

  it("stores the resolved dashboard origin, so later links use it", async () => {
    const mint = "ctcli_" + "f".repeat(48);
    const mock = await startMockCloud({ mintToken: mint });
    const withOverride = { ...env, CRUMBTRAIL_APP_URL: "https://app.example" };
    await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      openFn: () => false,
      env: withOverride,
      pollIntervalMs: 5,
    });
    expect(loadAuth(withOverride)?.appBaseUrl).toBe("https://app.example");
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
    const mint = "ctcli_" + "c".repeat(48);
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

describe("device flow rate limiting", () => {
  it("waits out a 429 and keeps polling instead of failing the login", async () => {
    // The exact shape that killed the previous hunt: the CLI spent the per-IP
    // auth budget on its own polls, and the FIRST answer after that was a 429 —
    // which used to abort the login while the code was still valid.
    const mint = "ctcli_" + "r".repeat(48);
    const mock = await startMockCloud({
      deviceRateLimitedPolls: 2,
      devicePendingPolls: 3, // 2 rate-limited + 1 pending, then the token
      mintToken: mint,
      retryAfterSeconds: 1,
    });
    const lines: string[] = [];
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: { out: (l = "") => lines.push(l), err: () => {} },
      noBrowser: true,
      env,
      pollIntervalMs: 5,
      pollWindowMs: 50,
      pollBudget: 10,
    });
    expect(token).toBe(mint);
    expect(mock.devicePolls).toBe(4);
    // And it said so, rather than looking hung.
    expect(lines.join("\n")).toMatch(/rate limiting sign-in attempts/i);
    await mock.close();
  }, 15000);

  it("keeps its polls inside a budget so the human's approval still fits", async () => {
    // 6 polls against a budget of 2 per 100ms window cannot finish in under two
    // full windows. The real numbers (5 per minute against the cloud's 10) are
    // the same arithmetic: the CLI never spends more than half the budget.
    const mint = "ctcli_" + "b".repeat(48);
    const mock = await startMockCloud({
      devicePendingPolls: 5,
      mintToken: mint,
    });
    const startedAt = Date.now();
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      noBrowser: true,
      env,
      pollIntervalMs: 1,
      pollWindowMs: 100,
      pollBudget: 2,
    });
    expect(token).toBe(mint);
    expect(mock.devicePolls).toBe(6);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    await mock.close();
  }, 15000);

  it("stores the dashboard origin the device flow reported", async () => {
    // The device verification URI is a DASHBOARD route, so its origin is the
    // app host. Without this the wizard's closing "Dashboard: …" link pointed
    // at the API port, which answers {"error":"Not found"}.
    const mock = await startMockCloud({
      mintToken: "ctcli_" + "d".repeat(48),
    });
    await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      noBrowser: true,
      env,
      pollIntervalMs: 5,
    });
    expect(loadAuth(env)?.appBaseUrl).toBe(mock.baseUrl);
    await mock.close();
  });
});

describe("naming the account that is being reused", () => {
  it("says whose login it is reusing", async () => {
    const stored = "ctcli_" + "s".repeat(48);
    const mock = await startMockCloud({
      validTokens: new Set([stored]),
      identity: {
        userId: "usr_1",
        tenantId: "ten_1",
        email: "someone@example.com",
      },
    });
    saveAuth(
      {
        token: stored,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: mock.baseUrl,
      },
      env,
    );
    clearIdentityCache();
    const lines: string[] = [];
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: { out: (l = "") => lines.push(l), err: () => {} },
      env,
    });
    expect(token).toBe(stored);
    expect(lines.join("\n")).toContain("someone@example.com");
    await mock.close();
  });

  it("falls back to the workspace id when the deployment reports no email", async () => {
    clearIdentityCache();
    expect(describeIdentity({ tenantId: "ten_9" })).toBe("workspace ten_9");
    expect(describeIdentity(undefined)).toBe("unknown account");
  });
});

describe("learning the dashboard origin without a login", () => {
  it("remembers what /auth/me reports, for a run authenticated by CRUMBTRAIL_TOKEN", async () => {
    const envToken = "ctcli_" + "u".repeat(48);
    const mock = await startMockCloud({
      validTokens: new Set([envToken]),
      identity: {
        userId: "usr_1",
        tenantId: "ten_1",
        appBaseUrl: "http://127.0.0.1:19892",
      },
    });
    clearIdentityCache();
    clearReportedAppBases();
    await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      env: { ...env, CRUMBTRAIL_TOKEN: envToken },
    });
    // Nothing was written to auth.json (an env credential isn't ours to cache),
    // so this in-run memory is the only thing standing between the user and a
    // dashboard link pointed at the API port.
    expect(loadAuth(env)).toBeUndefined();
    expect(reportedAppBase(mock.baseUrl)).toBe("http://127.0.0.1:19892");
    await mock.close();
  });

  it("reports nothing when the deployment says nothing", async () => {
    const envToken = "ctcli_" + "v".repeat(48);
    const mock = await startMockCloud({ validTokens: new Set([envToken]) });
    clearIdentityCache();
    clearReportedAppBases();
    await ensureToken({
      base: mock.baseUrl,
      ui: silentUi,
      env: { ...env, CRUMBTRAIL_TOKEN: envToken },
    });
    expect(reportedAppBase(mock.baseUrl)).toBeUndefined();
    await mock.close();
  });
});

describe("env token (CRUMBTRAIL_TOKEN)", () => {
  it("accepts a valid CRUMBTRAIL_TOKEN, skips the login flow, and never persists it", async () => {
    const envToken = "ctcli_" + "t".repeat(48);
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
        env: { ...env, CRUMBTRAIL_TOKEN: "ctcli_wrong" },
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
    const stored = "ctcli_" + "n".repeat(48);
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
    const stored = "ctcli_" + "d".repeat(48);
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
    const lines: string[] = [];
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: { out: (l = "") => lines.push(l), err: () => {} },
      openFn: () => {
        opened = true;
        return true;
      },
      env,
    });
    expect(token).toBe(stored);
    expect(opened).toBe(false); // no re-auth
    // "Using your saved login" alone was not checkable: someone pointing at a
    // local stack read it as proof the login belonged to that stack.
    expect(lines.join("\n")).toContain(
      `saved Crumbtrail login for ${mock.baseUrl}`,
    );
    expect(mock.exchanges).toBe(0);
    await mock.close();
  });

  it("does not reuse a saved login minted for a different endpoint", async () => {
    const stored = "ctcli_" + "x".repeat(48);
    const mint = "ctcli_" + "y".repeat(48);
    const mock = await startMockCloud({
      mintToken: mint,
      validTokens: new Set([stored, mint]),
    });
    saveAuth(
      {
        token: stored,
        expiresAt: "2099-01-01T00:00:00Z",
        endpoint: "https://api.other.example",
      },
      env,
    );
    const lines: string[] = [];
    const token = await ensureToken({
      base: mock.baseUrl,
      ui: { out: (l = "") => lines.push(l), err: () => {} },
      env,
      noBrowser: true,
      pollIntervalMs: 5,
    });
    expect(token).toBe(mint);
    expect(lines.join("\n")).toContain("https://api.other.example");
    expect(lines.join("\n")).toContain(mock.baseUrl);
    expect(lines.join("\n")).toMatch(/Saved login is for/);
    expect(loadAuth(env)?.token).toBe(mint);
    expect(loadAuth(env)?.endpoint).toBe(mock.baseUrl);
    await mock.close();
  });

  it("clears an invalid stored token and re-logs in", async () => {
    const stale = "ctcli_" + "e".repeat(48);
    const fresh = "ctcli_" + "f".repeat(48);
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
    saveAuth({ token: "ctcli_x", expiresAt: "x", endpoint: "x" }, env);
    expect(loadAuth(env)).toBeDefined();
    expect(clearAuth(env)).toBe(true);
    expect(loadAuth(env)).toBeUndefined();
    expect(clearAuth(env)).toBe(false); // already gone
  });
});
