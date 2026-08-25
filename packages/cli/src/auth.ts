// CLI authentication: PKCE browser hand-off (default) with an RFC-8628 device
// fallback, plus on-disk token persistence. See plans/cli-setup-wizard-design.md
// §2. node:http is used ONLY here (and verify.ts) — the detect/inject engine
// stays network-free.

import { createHash, randomBytes } from "node:crypto";
import { BRAND_FONT_STACK } from "crumbtrail-core";
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
import {
  APP_URL_ENV_VAR,
  ApiError,
  dashboardBase,
  normalizeBase,
  requestJson,
} from "./net";
import { color, readStdinLine, type Ui } from "./ui";
import { ok } from "./theme";

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
  /**
   * Where this deployment serves its dashboard, as the server reported it.
   * Locally the API and the app are different ports, so it cannot be derived
   * from `endpoint`, and every link the wizard printed from the API base 404ed.
   */
  appBaseUrl?: string;
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
        ...(typeof parsed.appBaseUrl === "string" && parsed.appBaseUrl
          ? { appBaseUrl: parsed.appBaseUrl }
          : {}),
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
<style>body{font-family:${BRAND_FONT_STACK};background:radial-gradient(circle at top,#16341f33,transparent 34rem),#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#1e293b;border:1px solid #334155;padding:2rem 2.5rem;border-radius:12px;text-align:center;box-shadow:0 24px 80px rgba(2,6,23,.5)}
h1{color:#22c55e;margin:0 0 .5rem;font-size:1.25rem}p{margin:0;color:#94a3b8}</style></head>
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
  /** The deployment's dashboard origin, when the server reported it. */
  appBaseUrl?: string;
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

// ── Who is signed in ─────────────────────────────────────────────────────────

/**
 * The account a token belongs to, as far as this deployment will say.
 *
 * A token is validated against the ENDPOINT, never against the project, so a
 * token left over from another workspace used to pass every check the CLI
 * made and then fail deep inside provisioning as "Project not found". Naming
 * the account on the line that says a login is being reused, and checking
 * `--project` against that account's list before creating a service, is what
 * makes that failure name the login instead of the id.
 */
export interface Identity {
  userId?: string;
  tenantId?: string;
  email?: string;
  workspaceName?: string;
}

/** One line naming the account: email if the deployment reports one, else ids. */
export function describeIdentity(identity: Identity | undefined): string {
  if (!identity) return "unknown account";
  if (identity.email) {
    return identity.workspaceName
      ? `${identity.email} · ${identity.workspaceName}`
      : identity.email;
  }
  if (identity.workspaceName) return identity.workspaceName;
  if (identity.tenantId) return `workspace ${identity.tenantId}`;
  if (identity.userId) return `user ${identity.userId}`;
  return "unknown account";
}

const identityCache = new Map<string, Identity | undefined>();

/**
 * Read GET /auth/me for the token's account. Never throws: identity is context,
 * and a deployment that will not answer must not be able to fail a setup run.
 * Memoized per endpoint+token so naming the account costs one request a run.
 */
export async function fetchIdentity(
  base: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<Identity | undefined> {
  const cacheKey = `${base}\u0000${token}`;
  if (identityCache.has(cacheKey)) return identityCache.get(cacheKey);
  let identity: Identity | undefined;
  try {
    const me = await requestJson<Record<string, unknown>>(`${base}/auth/me`, {
      token,
      fetchImpl,
    });
    const str = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    identity = {
      ...(str(me?.userId) ? { userId: str(me?.userId) } : {}),
      ...(str(me?.tenantId) ? { tenantId: str(me?.tenantId) } : {}),
      ...(str(me?.email) ? { email: str(me?.email) } : {}),
      ...((str(me?.workspaceName) ?? str(me?.tenantName))
        ? { workspaceName: str(me?.workspaceName) ?? str(me?.tenantName) }
        : {}),
    };
    if (Object.keys(identity).length === 0) identity = undefined;
  } catch {
    identity = undefined;
  }
  identityCache.set(cacheKey, identity);
  return identity;
}

/** Test seam: drop the memoized identities. */
export function clearIdentityCache(): void {
  identityCache.clear();
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
  /** Sliding budget window for device polls (ms); default POLL_WINDOW_MS. */
  pollWindowMs?: number;
  /** Device polls allowed per window; default DEVICE_POLL_BUDGET. */
  pollBudget?: number;
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

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Browser hand-off: open <base>/cli/authorize?port=&challenge=, then race the
 * localhost callback against a code pasted on stdin (for headless-but-clickable
 * setups where the redirect can't reach localhost). Throws so the caller can
 * fall back to the device flow if the browser can't be opened.
 */
export async function loginBrowser(opts: LoginOptions): Promise<TokenResponse> {
  const { verifier, challenge } = pkcePair();
  const server = await startCallbackServer();
  // /cli/authorize is a DASHBOARD route. Building it on `opts.base` pointed it
  // at the API host, which never serves the SPA, so the browser this flow opens
  // landed on a 404 in every deployment — hosted included — and the CLI then
  // sat waiting five minutes for an approval the user could not give.
  const appBase = dashboardBase(opts.base, undefined, opts.env ?? process.env);
  const authorizeUrl = `${appBase}/cli/authorize?port=${server.port}&challenge=${challenge}`;
  const missing = await signInPageMissing(authorizeUrl, opts.fetchImpl);
  if (missing) {
    // Opening a 404 and then waiting on it is the worst of both. Bail out so
    // the device flow gets its turn: that one is told the dashboard origin by
    // the deployment instead of deriving it.
    server.close();
    throw new Error(missing);
  }
  const open = opts.openFn ?? openBrowser;
  const opened = await open(authorizeUrl);
  if (!opened) {
    server.close();
    throw new Error("could not open a browser");
  }
  opts.ui.out(`Opened your browser to authorize the CLI:`);
  opts.ui.out(`  ${color.brand(authorizeUrl)}`);
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
 * How many token polls this CLI will spend inside `POLL_WINDOW_MS`.
 *
 * The cloud's auth limiter allows 10 requests a minute and buckets them BY
 * CLIENT IP as well as by credential — and the approval the user performs in
 * their browser comes from the same IP whenever the browser is on this machine,
 * which is the normal case. Polling at the advertised 5s interval therefore
 * spent the whole per-IP budget in 45 seconds, against a code that lives for
 * 300, and then blocked the human's own approval as well as itself.
 *
 * So the CLI spends at most half the budget and leaves the rest for the person.
 * Five polls a minute is a worst case of ~12s between an approval and the
 * terminal noticing it, in exchange for a login that cannot lock itself out.
 */
export const DEVICE_POLL_BUDGET = 5;
export const POLL_WINDOW_MS = 60_000;

/**
 * Spend one unit of a sliding-window budget, waiting if it is exhausted.
 * Returns the ms it waited. `spent` is mutated: it holds the timestamps of the
 * polls already made inside the window.
 */
async function awaitPollSlot(args: {
  spent: number[];
  budget: number;
  windowMs: number;
  minGapMs: number;
  now: () => number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<void> {
  const { spent, budget, windowMs, minGapMs, now, sleepFn } = args;
  const at = now();
  while (spent.length > 0 && spent[0]! <= at - windowMs) spent.shift();
  const sinceLast = spent.length > 0 ? at - spent[spent.length - 1]! : Infinity;
  let wait = sinceLast >= minGapMs ? 0 : minGapMs - sinceLast;
  if (spent.length >= budget) {
    // The window is full: wait for the oldest poll to age out of it.
    wait = Math.max(wait, spent[0]! + windowMs - at);
  }
  if (wait > 0) await sleepFn(wait);
  spent.push(now());
  while (spent.length > 0 && spent[0]! <= now() - windowMs) spent.shift();
}

/**
 * Device flow: request a code, print it, poll /api/cli/token until approval.
 * `authorization_pending` (400) keeps polling; `invalid_grant` aborts.
 *
 * A 429 is NOT fatal here. It means this CLI (or the person approving from the
 * same address) has spent the auth budget, and the only correct response is to
 * wait out the `Retry-After` the server sent and carry on polling — failing the
 * login instead is how `crumbtrail login` used to kill its own approval.
 */
export async function loginDevice(opts: LoginOptions): Promise<TokenResponse> {
  const device = await requestJson<DeviceStart>(`${opts.base}/api/cli/device`, {
    method: "POST",
    body: {},
    fetchImpl: opts.fetchImpl,
  });
  // The dashboard origin, resolved ONCE here and reused for every link this
  // login and the wizard after it will print. `verificationUri` is a dashboard
  // route, so the origin serving it IS the app host — but CRUMBTRAIL_APP_URL
  // outranks it, because a deployment whose PUBLIC_BASE_URL points at its own
  // API host reports an origin that serves no dashboard at all.
  const appBaseUrl = dashboardBase(
    opts.base,
    appOriginOf(device.verificationUri),
    opts.env ?? process.env,
  );
  const activateUrl = signInUrl(appBaseUrl, device.verificationUri);

  opts.ui.out("");
  opts.ui.out(`To authorize this CLI, visit:`);
  opts.ui.out(`  ${color.brand(activateUrl)}`);
  opts.ui.out(
    `and enter the code:  ${color.bold(color.brandLift(device.userCode))}`,
  );
  const missing = await signInPageMissing(activateUrl, opts.fetchImpl);
  if (missing) {
    // Never leave someone staring at a link that cannot work. Naming the lever
    // is the difference between a stuck login and a fixed one.
    opts.ui.out(color.yellow(`! ${missing}`));
  }
  opts.ui.out(color.dim("Waiting for approval…"));

  const intervalMs = opts.pollIntervalMs ?? Math.max(1, device.interval) * 1000;
  const windowMs = opts.pollWindowMs ?? POLL_WINDOW_MS;
  const budget = opts.pollBudget ?? DEVICE_POLL_BUDGET;
  const deadline = Date.now() + Math.max(1, device.expiresIn) * 1000;
  const spent: number[] = [];
  let warnedRateLimited = false;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(
        "Device authorization expired — run `crumbtrail login` again.",
      );
    }
    await awaitPollSlot({
      spent,
      budget,
      windowMs,
      minGapMs: intervalMs,
      now: Date.now,
      sleepFn: sleep,
    });
    try {
      const minted = await requestJson<TokenResponse>(
        `${opts.base}/api/cli/token`,
        {
          method: "POST",
          body: { deviceCode: device.deviceCode },
          fetchImpl: opts.fetchImpl,
          // Don't retry-on-5xx here; the polling loop is the retry.
          retry: false,
        },
      );
      // The resolved origin wins over whatever the token response repeated:
      // it already deferred to the deployment, and if it did not, that is the
      // user's CRUMBTRAIL_APP_URL saying the deployment is wrong.
      return { ...minted, appBaseUrl };
    } catch (err) {
      if (err instanceof ApiError && err.code === "authorization_pending") {
        continue;
      }
      if (err instanceof ApiError && err.status === 429) {
        // Told to wait: obey the number, and say so once so a stalled-looking
        // terminal is explained rather than mysterious.
        const waitSeconds = Math.max(1, err.retryAfterSeconds ?? 30);
        if (!warnedRateLimited) {
          warnedRateLimited = true;
          opts.ui.out(
            color.dim(
              `Crumbtrail is rate limiting sign-in attempts — waiting ${waitSeconds}s, then checking again. Your code is still valid.`,
            ),
          );
        }
        await sleep(waitSeconds * 1000);
        // A denied attempt still counts against the window on the server, so
        // it counts here too; anything else walks straight back into the wall.
        spent.push(Date.now());
        continue;
      }
      throw err;
    }
  }
}

/**
 * The origin of a dashboard URL the server gave us (`…/cli/activate`), or
 * undefined when it is not parseable. Only the origin is kept: the path is the
 * server's business, the origin is what every later link needs.
 */
export function appOriginOf(verificationUri: string): string | undefined {
  try {
    return new URL(verificationUri).origin;
  } catch {
    return undefined;
  }
}

/**
 * Put a sign-in URL on the dashboard origin, keeping the path the server chose.
 * The path is the deployment's business; the origin is ours, because only one
 * host in a split deployment serves the SPA these routes live in.
 */
export function signInUrl(appBase: string, uriOrPath: string): string {
  const base = normalizeBase(appBase);
  try {
    const parsed = new URL(uriOrPath);
    return `${base}${parsed.pathname}${parsed.search}`;
  } catch {
    return `${base}${uriOrPath.startsWith("/") ? "" : "/"}${uriOrPath}`;
  }
}

/**
 * Confirm a sign-in page exists before sending someone to it, and return the
 * line to show when it does not.
 *
 * Only a 404 counts. A redirect to a login screen, a 401, a 5xx, or no answer
 * at all are all things a working dashboard does; a 404 means this origin does
 * not serve the page, which is the one failure the user can actually fix.
 */
export async function signInPageMissing(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  let status: number;
  try {
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(url, { method: "GET" });
    status = res.status;
  } catch {
    return undefined;
  }
  if (status !== 404) return undefined;
  const origin = appOriginOf(url) ?? url;
  return (
    `${url} returns 404 — ${origin} is not serving Crumbtrail's dashboard. ` +
    `Set ${APP_URL_ENV_VAR} to your dashboard URL and run \`crumbtrail login\` again.`
  );
}

/** Pick the login flow: browser hand-off when viable, else device fallback. */
export async function login(opts: LoginOptions): Promise<TokenResponse> {
  const env = opts.env ?? process.env;
  if (canUseBrowser(opts.noBrowser ?? false, env)) {
    try {
      return await loginBrowser(opts);
    } catch (err) {
      // Say WHY. "Unavailable" alone sent people looking at their browser when
      // the real cause was a dashboard origin that serves no sign-in page.
      const why =
        err instanceof Error && err.message ? ` (${err.message})` : "";
      opts.ui.out(
        color.dim(
          `Browser hand-off unavailable${why} — falling back to device code.`,
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
      const identity = await fetchIdentity(opts.base, envToken, opts.fetchImpl);
      opts.ui.out(
        color.dim(
          `Using ${TOKEN_ENV_VAR} from the environment (${describeIdentity(identity)}).`,
        ),
      );
      return envToken;
    }
    // "Create one in the dashboard" was a dead end: the dashboard mints ingest
    // keys and agent tokens, and neither of those authenticates the CLI. The
    // only thing that does is a CLI token, and the only thing that makes one is
    // an interactive login — so say that, and say how to get its value out.
    throw new Error(
      `${TOKEN_ENV_VAR} was set but ${opts.base} rejected it (401). ` +
        `It must be a CLI token (starts with \`bl_cli_\`) — an ingest key ` +
        `(\`ctkey_\`) or an agent token (\`ctagt_\`) will not authenticate the ` +
        `CLI. Run \`crumbtrail login\` on a machine with a browser, then ` +
        `\`crumbtrail token\` to print the value to copy into CI. Add ` +
        `--endpoint <url> if this is not the deployment you logged in to.`,
    );
  }

  const stored = loadAuth(env);
  if (stored && stored.token && stored.endpoint === opts.base) {
    const state = await validateToken(opts.base, stored.token, opts.fetchImpl);
    if (state === "valid") {
      const identity = await fetchIdentity(
        opts.base,
        stored.token,
        opts.fetchImpl,
      );
      opts.ui.out(
        color.dim(
          `Using your saved Crumbtrail login (${describeIdentity(identity)}). Run \`crumbtrail logout\` to sign in as somebody else.`,
        ),
      );
      return stored.token;
    }
    clearAuth(env);
    opts.ui.out(color.dim("Saved login expired. Signing in again."));
  } else if (
    stored?.token &&
    stored.endpoint &&
    stored.endpoint !== opts.base
  ) {
    // A token minted for another deployment is not a token for this one.
    // Don't reuse it, and say so: silent fall-through to a fresh login made
    // it look as if this machine had no login at all.
    opts.ui.out(
      color.dim(
        `Saved login is for ${stored.endpoint}, not ${opts.base}. Signing in to this endpoint.`,
      ),
    );
  }

  // No env token and no reusable cached token — the only way forward is an
  // interactive login. In a non-TTY shell that would block forever (waiting on a
  // browser callback or a device-code approval nobody can perform), so fail fast
  // with the concrete way out instead of hanging.
  if (opts.allowInteractiveLogin === false) {
    throw new Error(
      `No Crumbtrail login available and this shell isn't interactive. ` +
        `To run in CI: run \`crumbtrail login\` once on a machine with a ` +
        `browser, print the token with \`crumbtrail token\`, and set it as ` +
        `${TOKEN_ENV_VAR}. The dashboard's agent tokens are for the MCP server ` +
        `and are rejected here. Add --endpoint <url> if you point at a ` +
        `self-hosted Crumbtrail.`,
    );
  }

  const minted = await login(opts);
  saveAuth(
    {
      token: minted.token,
      expiresAt: minted.expiresAt,
      endpoint: opts.base,
      ...(minted.appBaseUrl ? { appBaseUrl: minted.appBaseUrl } : {}),
    },
    env,
  );
  opts.ui.out(ok("Logged in."));
  return minted.token;
}
