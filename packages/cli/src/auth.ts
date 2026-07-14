// CLI authentication: PKCE browser hand-off (default) with an RFC-8628 device
// fallback, plus on-disk token persistence. See plans/cli-setup-wizard-design.md
// §2. node:http is used ONLY here (and verify.ts) — the detect/inject engine
// stays network-free.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ApiError, requestJson } from "./net";
import { color, readStdinLine, type Ui } from "./ui";

// ── PKCE ─────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generate a PKCE S256 pair. 32 random bytes → 43-char base64url verifier; its
 * SHA-256 (base64url) is the 43-char challenge that must satisfy the cloud's
 * CHALLENGE_RE (`^[A-Za-z0-9_-]{43}$`).
 */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── Token persistence (0600) ─────────────────────────────────────────────────

export interface StoredAuth {
  token: string;
  expiresAt: string;
  /** Endpoint the token was minted against — a token is only reused for its base. */
  endpoint: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim();
  const base = xdg || path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "crumbtrail");
}

export function authFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "auth.json");
}

export function loadAuth(
  env: NodeJS.ProcessEnv = process.env,
): StoredAuth | undefined {
  try {
    const raw = readFileSync(authFilePath(env), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (typeof parsed.token === "string" && parsed.token) {
      return {
        token: parsed.token,
        expiresAt: String(parsed.expiresAt ?? ""),
        endpoint: String(parsed.endpoint ?? ""),
      };
    }
  } catch {
    // missing / unreadable / malformed → treated as "no stored auth"
  }
  return undefined;
}

/** Persist auth at 0600 (write with mode, then chmod to force perms on reuse). */
export function saveAuth(
  auth: StoredAuth,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = authFilePath(env);
  writeFileSync(file, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = authFilePath(env);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// ── Browser open (cross-platform, no shell) ──────────────────────────────────

/**
 * Open `url` in the default browser without a shell (spawn with an args array so
 * the URL can never be interpreted as a command). Resolves false when the opener
 * cannot be spawned (e.g. ENOENT — `xdg-open` missing even though DISPLAY is
 * set), so the caller can fall back to the device flow. Spawn failure is only
 * known asynchronously (the child's `error` event), so this MUST be a Promise —
 * a synchronous "assume success" would let the caller print "Opened your
 * browser…" and hang waiting for a callback that will never arrive.
 * `spawnFn` is an injectable seam for tests.
 */
export function openBrowser(
  url: string,
  spawnFn: typeof spawn = spawn,
): Promise<boolean> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd builtin; the empty "" is the (ignored) window title so a
    // quoted URL isn't consumed as one. No shell:true — args are passed literally.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawnFn(cmd, args, { stdio: "ignore", detached: true });
      let settled = false;
      child.on("error", () => {
        if (settled) return;
        settled = true;
        resolve(false);
      });
      // Node emits `spawn` once the child process has actually been launched —
      // the clean signal that the opener command exists and started.
      child.on("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** True when a browser hand-off is viable: not --no-browser, and a display exists. */
export function canUseBrowser(
  noBrowser: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (noBrowser) return false;
  // A Linux box with no DISPLAY/WAYLAND can't pop a browser → device flow.
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return false;
  }
  return true;
}

// ── Localhost callback listener ──────────────────────────────────────────────

export interface CallbackServer {
  port: number;
  /** Resolves with the grant code when the browser hits /callback?code=…. */
  waitForCode: Promise<string>;
  close(): void;
}

const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Crumbtrail CLI</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1e293b;padding:2rem 2.5rem;border-radius:12px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{color:#319B7C;margin:0 0 .5rem;font-size:1.25rem}p{margin:0;color:#94a3b8}</style></head>
<body><div class="card"><h1>Crumbtrail connected ✓</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`;

/** Start an ephemeral localhost listener that captures the browser callback. */
export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // Avoid an unhandled-rejection if nobody ever awaits (device fallback path).
    waitForCode.catch(() => {});

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(code ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(CALLBACK_PAGE);
      if (code) resolveCode(code);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("callback server failed to bind"));
        return;
      }
      resolve({
        port: addr.port,
        waitForCode,
        close: () => {
          rejectCode(new Error("cancelled"));
          server.close();
        },
      });
    });
  });
}

// ── Exchange / validate ──────────────────────────────────────────────────────

export interface TokenResponse {
  token: string;
  expiresAt: string;
}

/** Exchange a browser-handoff grant code + PKCE verifier for a CLI token. */
export async function exchangeCode(
  base: string,
  args: { code: string; verifier: string },
  fetchImpl?: typeof fetch,
): Promise<TokenResponse> {
  return requestJson<TokenResponse>(`${base}/api/cli/token`, {
    method: "POST",
    body: { code: args.code, verifier: args.verifier },
    fetchImpl,
  });
}

/** GET /api/projects as a cheap token probe: "valid" | "invalid" (401). */
export async function validateToken(
  base: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<"valid" | "invalid"> {
  try {
    await requestJson(`${base}/api/projects`, { token, fetchImpl });
    return "valid";
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return "invalid";
    throw err;
  }
}

// ── Login flows ──────────────────────────────────────────────────────────────

export interface LoginOptions {
  base: string;
  ui: Ui;
  noBrowser?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected browser opener (tests). */
  openFn?: (url: string) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Device-poll interval override for tests (ms). */
  pollIntervalMs?: number;
  /** Browser hand-off deadline in ms (default 5 min); overridable in tests. */
  browserDeadlineMs?: number;
  /**
   * False in a non-TTY shell: refuse to START an interactive login (browser
   * hand-off / device code) that would block on input nobody can give, and throw
   * an actionable error instead of hanging. Undefined/true keeps the interactive
   * flow (default) so a normal terminal is unaffected. A valid CRUMBTRAIL_TOKEN or
   * a cached token is honored regardless of this flag.
   */
  allowInteractiveLogin?: boolean;
}

/** Env var carrying a pre-minted CLI token for non-interactive (CI) runs. */
export const TOKEN_ENV_VAR = "CRUMBTRAIL_TOKEN";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Browser hand-off: open <base>/cli/authorize?port=&challenge=, then race the
 * localhost callback against a code pasted on stdin (for headless-but-clickable
 * setups where the redirect can't reach localhost). Throws so the caller can
 * fall back to the device flow if the browser can't be opened.
 */
export async function loginBrowser(opts: LoginOptions): Promise<TokenResponse> {
  const { verifier, challenge } = pkcePair();
  const server = await startCallbackServer();
  const authorizeUrl = `${opts.base}/cli/authorize?port=${server.port}&challenge=${challenge}`;
  const open = opts.openFn ?? openBrowser;
  const opened = await open(authorizeUrl);
  if (!opened) {
    server.close();
    throw new Error("could not open a browser");
  }
  opts.ui.out(`Opened your browser to authorize the CLI:`);
  opts.ui.out(`  ${color.cyan(authorizeUrl)}`);
  opts.ui.out(
    color.dim(`Waiting for approval… (or paste the code shown in the browser)`),
  );

  const stdin = readStdinLine();
  // A pasted code competes with the localhost callback. stdin EOF (closed pipe)
  // must NOT lose the race — only a real non-empty line resolves; otherwise this
  // branch stays pending so the callback still wins.
  const pastedCode = stdin.promise.then<string>((line) =>
    line ? line : new Promise<string>(() => {}),
  );
  // Third racer: a deadline so an abandoned approval can't hang the CLI forever
  // (mirrors loginDevice's expiry). It only ever rejects; it never resolves a
  // code, so it can't win against a real callback. Cleared in finally alongside
  // the stdin listener + callback server so nothing is left dangling.
  const deadlineMs = opts.browserDeadlineMs ?? 5 * 60 * 1000;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(
        new Error(
          "Browser authorization timed out — run `crumbtrail login` again.",
        ),
      );
    }, deadlineMs);
    deadlineTimer.unref?.();
  });
  try {
    const code = await Promise.race([server.waitForCode, pastedCode, deadline]);
    return await exchangeCode(opts.base, { code, verifier }, opts.fetchImpl);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    stdin.cancel();
    server.close();
  }
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Device flow: request a code, print it, poll /api/cli/token until approval.
 * `authorization_pending` (400) keeps polling; `invalid_grant` aborts.
 */
export async function loginDevice(opts: LoginOptions): Promise<TokenResponse> {
  const device = await requestJson<DeviceStart>(`${opts.base}/api/cli/device`, {
    method: "POST",
    body: {},
    fetchImpl: opts.fetchImpl,
  });
  opts.ui.out("");
  opts.ui.out(`To authorize this CLI, visit:`);
  opts.ui.out(`  ${color.cyan(device.verificationUri)}`);
  opts.ui.out(`and enter the code:  ${color.bold(device.userCode)}`);
  opts.ui.out(color.dim("Waiting for approval…"));

  const intervalMs = opts.pollIntervalMs ?? Math.max(1, device.interval) * 1000;
  const deadline = Date.now() + Math.max(1, device.expiresIn) * 1000;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(
        "Device authorization expired — run `crumbtrail login` again.",
      );
    }
    await sleep(intervalMs);
    try {
      return await requestJson<TokenResponse>(`${opts.base}/api/cli/token`, {
        method: "POST",
        body: { deviceCode: device.deviceCode },
        fetchImpl: opts.fetchImpl,
        // Don't retry-on-5xx here; the polling loop is the retry.
        retry: false,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "authorization_pending") {
        continue;
      }
      throw err;
    }
  }
}

/** Pick the login flow: browser hand-off when viable, else device fallback. */
export async function login(opts: LoginOptions): Promise<TokenResponse> {
  const env = opts.env ?? process.env;
  if (canUseBrowser(opts.noBrowser ?? false, env)) {
    try {
      return await loginBrowser(opts);
    } catch {
      opts.ui.out(
        color.dim(
          "Browser hand-off unavailable — falling back to device code.",
        ),
      );
      return loginDevice(opts);
    }
  }
  return loginDevice(opts);
}

/**
 * Resolve a usable CLI token for `base`: reuse a stored token (validated by a
 * cheap GET /api/projects, and only if it was minted for THIS endpoint), else
 * run the login flow and persist the result. A stored token that 401s is
 * cleared and re-minted.
 */
export async function ensureToken(opts: LoginOptions): Promise<string> {
  const env = opts.env ?? process.env;

  // 0. Non-interactive escape hatch: an explicit CRUMBTRAIL_TOKEN skips the whole
  // login dance (the CI path — a headless run can't click a browser or paste a
  // device code). It's validated against THIS endpoint, because a token minted
  // for another deployment is useless here, and it is never written to disk — an
  // env-provided credential isn't ours to cache or clear. A token that's set but
  // rejected is a hard error, not a silent fall-through to a hang.
  const envToken = env[TOKEN_ENV_VAR]?.trim();
  if (envToken) {
    const state = await validateToken(opts.base, envToken, opts.fetchImpl);
    if (state === "valid") {
      opts.ui.out(color.dim(`Using ${TOKEN_ENV_VAR} from the environment.`));
      return envToken;
    }
    throw new Error(
      `${TOKEN_ENV_VAR} was set but ${opts.base} rejected it (401). ` +
        `Check the token value (create one in the dashboard), or point at the ` +
        `right deployment with --endpoint <url>.`,
    );
  }

  const stored = loadAuth(env);
  if (stored && stored.token && stored.endpoint === opts.base) {
    const state = await validateToken(opts.base, stored.token, opts.fetchImpl);
    if (state === "valid") {
      opts.ui.out(color.dim("Using your saved Crumbtrail login."));
      return stored.token;
    }
    clearAuth(env);
    opts.ui.out(color.dim("Saved login expired — signing in again."));
  }

  // No env token and no reusable cached token — the only way forward is an
  // interactive login. In a non-TTY shell that would block forever (waiting on a
  // browser callback or a device-code approval nobody can perform), so fail fast
  // with the concrete way out instead of hanging.
  if (opts.allowInteractiveLogin === false) {
    throw new Error(
      `No Crumbtrail login available and this shell isn't interactive. ` +
        `Set ${TOKEN_ENV_VAR}=<your CLI token> (create one in the dashboard) to ` +
        `run in CI, or run the wizard in an interactive terminal. ` +
        `Add --endpoint <url> if you point at a self-hosted Crumbtrail.`,
    );
  }

  const minted = await login(opts);
  saveAuth(
    { token: minted.token, expiresAt: minted.expiresAt, endpoint: opts.base },
    env,
  );
  opts.ui.out(color.green("Logged in ✓"));
  return minted.token;
}
