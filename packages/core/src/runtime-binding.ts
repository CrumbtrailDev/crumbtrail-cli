/**
 * The server issued identity used to target live probe delivery.
 *
 * This module intentionally keeps the bearer in a private client instance. The
 * caller gets no public metadata or event payload containing the proof. A
 * binding is only returned to the two HTTP seams that need to authenticate a
 * session start and a config poll.
 */

export interface RuntimeBinding {
  readonly instanceId: string;
  readonly instanceProof: string;
  readonly expiresAt: string;
}

export interface RuntimeBindingClientOptions {
  endpoint: string;
  projectKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Internal retirement gate used by the bounded serverless cache. */
  ready?: Promise<void>;
}

export interface RuntimeBindingHandleOptions {
  endpoint: string;
  projectKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

declare const runtimeBindingHandleBrand: unique symbol;

/** An opaque binding owned by the SDK. It contains no bearer or callable access to one. */
export interface RuntimeBindingHandle {
  readonly [runtimeBindingHandleBrand]: "RuntimeBindingHandle";
}

export interface RuntimeBindingConfigResponse {
  readonly response: Response;
  readonly targeted: boolean;
}

/** Rotate well before the one day proof lifetime ends. */
export const RUNTIME_BINDING_ROTATE_AHEAD_MS = 60 * 60 * 1000;

/** Do not let a server supplied retry delay park capture forever. */
const RUNTIME_BINDING_MAX_RETRY_MS = 5 * 60 * 1000;

/** Avoid a zero second hint turning a fast config poll into a registration loop. */
const RUNTIME_BINDING_MIN_RETRY_MS = 1_000;

/** Back off transient registration failures even when the server gives no hint. */
const RUNTIME_BINDING_DEFAULT_RETRY_MS = 30 * 1000;

/** Registration must not hold the first session handshake indefinitely. */
const RUNTIME_BINDING_REQUEST_TIMEOUT_MS = 3_000;

/** Retiring a binding is best effort and must not hold an invocation forever. */
const RUNTIME_BINDING_REVOKE_TIMEOUT_MS = 3_000;

/** Keep warm-runtime defaults bounded when one process serves many projects. */
export const RUNTIME_BINDING_CACHE_MAX_ENTRIES = 32;

/**
 * Unsettled retirement gates are never evicted for space. Once this finite
 * admission limit is reached, new cache entries use an uncached client until a
 * gate settles.
 */
export const RUNTIME_BINDING_MAX_PENDING_RETIREMENTS =
  RUNTIME_BINDING_CACHE_MAX_ENTRIES * 2;

/** Drop abandoned warm-runtime defaults after one proof lifetime. */
export const RUNTIME_BINDING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RuntimeBindingResponse {
  instanceId?: unknown;
  instanceProof?: unknown;
  expiresAt?: unknown;
}

class RuntimeBindingTimeoutError extends Error {
  constructor() {
    super("runtime binding registration timed out");
    this.name = "RuntimeBindingTimeoutError";
  }
}

interface RuntimeBindingCacheEntry {
  client: RuntimeBindingClient;
  lastUsedAt: number;
}

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

interface LateCleanupWindow {
  promise: Promise<void>;
  arm(): void;
  close(): void;
  run(task: (timeoutMs: number) => Promise<void> | void): void;
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Reserve a bounded window for cleanup that can only begin after a timed-out
 * response or body becomes observable. Once the window closes, a late value is
 * ignored so cleanup cannot begin after the retirement gate has settled.
 */
function createLateCleanupWindow(timeoutMs: number): LateCleanupWindow {
  const deferred = createDeferredPromise<void>();
  let closed = false;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    deferred.resolve();
  };

  return {
    promise: deferred.promise,
    arm() {
      if (closed || timer !== undefined) return;
      deadline = Date.now() + timeoutMs;
      timer = setTimeout(close, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    close,
    run(task) {
      if (closed || deadline === 0) return;
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        close();
        return;
      }
      void Promise.resolve()
        .then(() => task(remaining))
        .catch(() => {})
        .finally(close);
    },
  };
}

const runtimeBindingCache = new Map<string, RuntimeBindingCacheEntry>();
const runtimeBindingRetirements = new Map<string, Promise<void>>();
const runtimeBindingFunctionIds = new WeakMap<object, number>();
let nextRuntimeBindingFunctionId = 1;
const runtimeBindingHandles = new WeakMap<
  RuntimeBindingHandle,
  RuntimeBindingClient
>();

/**
 * Owns one browser tab or Node process binding.
 *
 * The client itself has no module-level storage. Browser callers create one per
 * runtime, keeping a binding scoped to that tab and preventing a key or proof
 * from one origin or project being reused by another initialization. The
 * serverless default wrapper owns a separate bounded cache keyed by endpoint,
 * project, and the identity of any supplied fetch or clock seam. Node callers
 * can keep one explicit instance across re-establishes.
 */
export class RuntimeBindingClient {
  private readonly endpoint: string;
  private readonly projectKey: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly now: () => number;
  private current: RuntimeBinding | undefined;
  private inFlight: Promise<RuntimeBinding | undefined> | undefined;
  private retryAfter = 0;
  private requestGeneration = 0;
  private stopped = false;
  private activeRegistrationController: AbortController | undefined;
  private retirement: Promise<void> | undefined;
  private readonly ready: Promise<void>;
  private readonly bindingOrigin: string | undefined;
  private pendingRetirements = new Set<Promise<void>>();
  private lateCleanupWindows = new Set<LateCleanupWindow>();

  constructor(options: RuntimeBindingClientOptions) {
    this.endpoint = options.endpoint.trim().replace(/\/+$/, "");
    this.projectKey = options.projectKey?.trim() ?? "";
    this.fetcher =
      options.fetchImpl ??
      (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.now = options.now ?? Date.now;
    this.ready = options.ready ?? Promise.resolve();
    this.bindingOrigin = resolveOrigin(this.endpoint);
  }

  /**
   * Return a usable binding, registering or rotating at most once per call.
   * Registration failures are intentionally swallowed so old SDK behaviour is
   * preserved when Cloud is unavailable or does not yet expose this route.
   */
  async getBinding(): Promise<RuntimeBinding | undefined> {
    await this.ready;
    if (this.stopped || !this.projectKey || !this.endpoint || !this.fetcher)
      return undefined;

    const now = this.now();
    if (this.current && this.isUsable(this.current, now)) {
      if (
        this.expiresAtMs(this.current) - now >
        RUNTIME_BINDING_ROTATE_AHEAD_MS
      )
        return this.current;
    }
    if (this.inFlight) return this.inFlight;
    if (now < this.retryAfter) {
      return this.current && this.isUsable(this.current, now)
        ? this.current
        : undefined;
    }

    const previous = this.current;
    const generation = ++this.requestGeneration;
    const requestLifecycle = createDeferredPromise<void>();
    this.trackRetirement(requestLifecycle.promise);
    const request = this.registerOrRotate(previous, generation);
    this.inFlight = request;
    try {
      const next = await request;
      if (!this.stopped && generation === this.requestGeneration && next)
        this.current = next;
      if ((this.stopped || generation !== this.requestGeneration) && next)
        await this.revokeLatePayload(next);
      const fallback =
        generation === this.requestGeneration &&
        this.current &&
        this.isUsable(this.current, this.now())
          ? this.current
          : undefined;
      return this.stopped ? undefined : (next ?? fallback);
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
      requestLifecycle.resolve();
    }
  }

  matchesOrigin(endpoint: string): boolean {
    const targetOrigin = resolveOrigin(endpoint);
    return Boolean(
      this.bindingOrigin && targetOrigin && this.bindingOrigin === targetOrigin,
    );
  }

  matchesScope(endpoint: string, projectKey?: string): boolean {
    return (
      this.endpoint === endpoint.trim().replace(/\/+$/, "") &&
      this.projectKey === (projectKey?.trim() ?? "")
    );
  }

  async fetchConfig(
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<RuntimeBindingConfigResponse | undefined> {
    if (signal?.aborted)
      throw signal.reason ?? new Error("Config poll aborted");
    const fetcher = this.fetcher;
    if (!fetcher) return undefined;

    const targetedOrigin = this.matchesOrigin(endpoint);
    const binding = targetedOrigin
      ? await waitForConfigSignal(this.getBinding(), signal)
      : undefined;
    if (signal?.aborted)
      throw signal.reason ?? new Error("Config poll aborted");
    const url = new URL(
      endpoint,
      this.endpoint ||
        (typeof location !== "undefined" ? location.href : "http://localhost/"),
    );
    if (binding) url.searchParams.set("instanceId", binding.instanceId);
    const response = await waitForConfigSignal(
      fetcher(url.toString(), {
        method: "GET",
        cache: "no-store",
        signal,
        ...(binding
          ? { headers: { Authorization: `Bearer ${binding.instanceProof}` } }
          : {}),
      }),
      signal,
    );
    if (response.status === 401 && binding) this.invalidate();
    return { response, targeted: binding !== undefined };
  }

  /** Clear the private proof and prevent late registration responses being adopted. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.requestGeneration += 1;
    try {
      this.activeRegistrationController?.abort();
    } catch {
      // A host supplied AbortController must not break retirement.
    }
    for (const window of this.lateCleanupWindows) window.arm();
    const previous = this.current;
    this.current = undefined;
    this.retryAfter = 0;
    const retirements = [...this.pendingRetirements];
    if (previous) retirements.push(this.revoke(previous));
    this.retirement = Promise.allSettled(retirements).then(() => undefined);
  }

  /**
   * Forget a proof the server rejected while leaving this client able to
   * register a fresh runtime identity on the next poll.
   */
  invalidate(): void {
    if (this.stopped) return;
    this.requestGeneration += 1;
    try {
      this.activeRegistrationController?.abort();
    } catch {
      // A host supplied AbortController must not break the invalidation path.
    }
    this.current = undefined;
    this.retryAfter = 0;
  }

  private async registerOrRotate(
    previous: RuntimeBinding | undefined,
    generation: number,
  ): Promise<RuntimeBinding | undefined> {
    const fetcher = this.fetcher;
    if (!fetcher) return undefined;
    const now = this.now();
    const lateResponse = createLateCleanupWindow(
      RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
    );
    this.trackLateCleanup(lateResponse);
    let requestTimedOut = false;
    try {
      const url = new URL(
        `${this.endpoint}/api/runtime/register`,
        typeof location !== "undefined" ? location.href : "http://localhost/",
      );
      url.searchParams.set("projectKey", this.projectKey);
      const headers: Record<string, string> = {};
      if (previous && this.isUsable(previous, now)) {
        url.searchParams.set("instanceId", previous.instanceId);
        headers.Authorization = `Bearer ${previous.instanceProof}`;
      }
      const Controller = globalThis.AbortController;
      const controller =
        typeof Controller === "function" ? new Controller() : undefined;
      this.activeRegistrationController = controller;
      let response: Response;
      try {
        const deadline = Date.now() + RUNTIME_BINDING_REQUEST_TIMEOUT_MS;
        response = await fetchWithTimeout(
          fetcher,
          url.toString(),
          {
            method: "POST",
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            cache: "no-store",
          },
          Math.max(0, deadline - Date.now()),
          controller,
          (response) =>
            lateResponse.run((timeoutMs) =>
              this.revokeLateResponse(response, timeoutMs),
            ),
          () => {
            requestTimedOut = true;
            lateResponse.arm();
          },
        );
        if (!requestTimedOut) lateResponse.close();
        if (this.stopped || generation !== this.requestGeneration) {
          await this.revokeLateResponse(
            response,
            RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
          );
          return undefined;
        }
        if (!response.ok) {
          this.armRetry(response);
          // A throttled or unreachable endpoint does not invalidate a proof that
          // remains live. A 401 on rotation does, so the next request falls back
          // to the old untargeted contract until a fresh registration succeeds.
          if (response.status === 401 && previous) this.current = undefined;
          return undefined;
        }
        const latePayload = createLateCleanupWindow(
          RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
        );
        this.trackLateCleanup(latePayload);
        let bodyTimedOut = false;
        let payload: RuntimeBindingResponse;
        try {
          payload = (await responseJsonWithTimeout(
            response,
            Math.max(0, deadline - Date.now()),
            controller,
            (value) =>
              latePayload.run((timeoutMs) =>
                this.revokeLatePayload(value, timeoutMs),
              ),
            () => {
              bodyTimedOut = true;
              latePayload.arm();
            },
          )) as RuntimeBindingResponse;
          if (!bodyTimedOut) latePayload.close();
        } finally {
          if (!bodyTimedOut) latePayload.close();
        }
        if (this.stopped || generation !== this.requestGeneration) {
          await this.revokeLatePayload(
            payload,
            RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
          );
          return undefined;
        }
        const binding = parseRuntimeBinding(payload, this.now());
        if (!binding) {
          this.armRetry();
          return undefined;
        }
        this.retryAfter = 0;
        return binding;
      } finally {
        if (this.activeRegistrationController === controller)
          this.activeRegistrationController = undefined;
      }
    } catch (error) {
      if (error instanceof RuntimeBindingTimeoutError) {
        // A timeout is ambiguous. The server may have committed rotation
        // before the client stopped waiting, so the previous proof cannot be
        // used again. Invalidate the generation so a late response is ignored.
        this.current = undefined;
        this.requestGeneration += 1;
      }
      if (!this.stopped) this.armRetry();
      return undefined;
    } finally {
      if (!requestTimedOut) lateResponse.close();
    }
  }

  private armRetry(response?: Response): void {
    const hinted = response
      ? retryAfterMs(response.headers.get("Retry-After"), this.now())
      : undefined;
    this.retryAfter =
      this.now() +
      Math.max(
        RUNTIME_BINDING_MIN_RETRY_MS,
        Math.min(
          hinted ?? RUNTIME_BINDING_DEFAULT_RETRY_MS,
          RUNTIME_BINDING_MAX_RETRY_MS,
        ),
      );
  }

  private expiresAtMs(binding: RuntimeBinding): number {
    return Date.parse(binding.expiresAt);
  }

  private isUsable(binding: RuntimeBinding, now: number): boolean {
    const expiresAt = this.expiresAtMs(binding);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  private async revoke(
    binding: RuntimeBinding,
    timeoutMs = RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
  ): Promise<void> {
    const fetcher = this.fetcher;
    if (!fetcher || !this.projectKey || !this.endpoint || timeoutMs <= 0)
      return;
    try {
      const url = new URL(
        `${this.endpoint}/api/runtime/register`,
        typeof location !== "undefined" ? location.href : "http://localhost/",
      );
      url.searchParams.set("projectKey", this.projectKey);
      url.searchParams.set("instanceId", binding.instanceId);
      await fetchWithTimeout(
        fetcher,
        url.toString(),
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${binding.instanceProof}` },
          cache: "no-store",
        },
        timeoutMs,
      );
    } catch {
      // Revocation is best effort. Capture already fell back to the old
      // untargeted contract when stop or eviction cleared this binding.
    }
  }

  private async revokeLateResponse(
    response: Response,
    timeoutMs: number,
  ): Promise<void> {
    if (!response.ok) return;
    const deadline = Date.now() + timeoutMs;
    try {
      const payload = await responseJsonWithTimeout(
        response,
        timeoutMs,
        undefined,
      );
      await this.revokeLatePayload(payload, deadline - Date.now());
    } catch {
      // Late cleanup is bounded and best effort.
    }
  }

  private async revokeLatePayload(
    value: unknown,
    timeoutMs = RUNTIME_BINDING_REVOKE_TIMEOUT_MS,
  ): Promise<void> {
    const binding = parseRuntimeBinding(
      (value ?? {}) as RuntimeBindingResponse,
      this.now(),
    );
    if (binding) await this.revoke(binding, timeoutMs).catch(() => {});
  }

  private trackRetirement(retirement: Promise<void>): void {
    this.pendingRetirements.add(retirement);
    void retirement.then(
      () => this.pendingRetirements.delete(retirement),
      () => this.pendingRetirements.delete(retirement),
    );
  }

  private trackLateCleanup(window: LateCleanupWindow): void {
    this.lateCleanupWindows.add(window);
    this.trackRetirement(window.promise);
    void window.promise.then(() => this.lateCleanupWindows.delete(window));
  }

  /** Internal cache seam. The public stop operation remains synchronous. */
  getRetirement(): Promise<void> {
    return this.retirement ?? Promise.resolve();
  }
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  providedController?: AbortController,
  onLateResponse?: (response: Response) => void,
  onTimeout?: () => void,
): Promise<Response> {
  const Controller = globalThis.AbortController;
  const controller =
    providedController ??
    (typeof Controller === "function" ? new Controller() : undefined);
  let request: Promise<Response>;
  try {
    request = Promise.resolve(
      fetcher(input, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      }),
    );
  } catch (error) {
    request = Promise.reject(error);
  }
  return awaitWithTimeout(
    request,
    timeoutMs,
    controller,
    onLateResponse,
    onTimeout,
  );
}

async function responseJsonWithTimeout(
  response: Response,
  timeoutMs: number,
  controller: AbortController | undefined,
  onLatePayload?: (payload: unknown) => void,
  onTimeout?: () => void,
  bodyPromise: Promise<unknown> = Promise.resolve().then(() => response.json()),
): Promise<unknown> {
  return awaitWithTimeout(
    bodyPromise,
    timeoutMs,
    controller,
    onLatePayload,
    onTimeout,
  );
}

async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController | undefined,
  onLate?: (value: T) => void,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const observed = promise.then(
    (value) => {
      if (timedOut && onLate) {
        try {
          onLate(value);
        } catch {
          // Late cleanup is best effort and must not create an unhandled rejection.
        }
      }
      return value;
    },
    (error: unknown) => {
      throw error;
    },
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        try {
          onTimeout?.();
        } catch {
          // Timeout bookkeeping must not prevent the bounded rejection.
        }
        try {
          controller?.abort();
        } finally {
          reject(new RuntimeBindingTimeoutError());
        }
      },
      Math.max(0, timeoutMs),
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([observed, timeout]);
  } catch (error) {
    if (timedOut) throw new RuntimeBindingTimeoutError();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRuntimeBindingClient(
  options: RuntimeBindingClientOptions,
): RuntimeBindingClient {
  return new RuntimeBindingClient(options);
}

export function createRuntimeBindingHandle(
  options: RuntimeBindingHandleOptions,
): RuntimeBindingHandle {
  const handle = Object.freeze({}) as RuntimeBindingHandle;
  runtimeBindingHandles.set(handle, createRuntimeBindingClient(options));
  return handle;
}

export function resolveRuntimeBindingClient(
  handle: RuntimeBindingHandle,
): RuntimeBindingClient | undefined {
  return runtimeBindingHandles.get(handle);
}

export function retireRuntimeBindingHandle(
  handle: RuntimeBindingHandle,
): Promise<void> {
  const client = resolveRuntimeBindingClient(handle);
  if (!client) return Promise.resolve();
  client.stop();
  return client.getRetirement();
}

export function fetchRuntimeBindingConfig(
  handle: RuntimeBindingHandle,
  endpoint: string,
  signal?: AbortSignal,
): Promise<RuntimeBindingConfigResponse | undefined> {
  return (
    resolveRuntimeBindingClient(handle)?.fetchConfig(endpoint, signal) ??
    Promise.resolve(undefined)
  );
}

/** Cancel this config consumer's wait without retiring another consumer's binding. */
async function waitForConfigSignal<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Config poll aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reuse one binding across warm serverless invocations when the endpoint,
 * project, and supplied function seams are the same. Function identity is
 * intentional: a different fetch or clock must never reuse a client that holds
 * the other invocation's closures. The bounded LRU keeps a process that serves
 * many identities from retaining every client forever.
 */
export function getCachedRuntimeBindingClient(
  options: RuntimeBindingClientOptions,
): RuntimeBindingClient {
  const endpoint = options.endpoint.trim().replace(/\/+$/, "");
  const projectKey = options.projectKey?.trim() ?? "";
  if (!endpoint || !projectKey) return createRuntimeBindingClient(options);

  const fetchIdentity = functionIdentity(
    options.fetchImpl ??
      (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined),
  );
  const nowIdentity = functionIdentity(options.now ?? Date.now);
  const key = `${endpoint}\u0000${projectKey}\u0000fetch:${fetchIdentity}\u0000now:${nowIdentity}`;

  const now = Date.now();
  pruneRuntimeBindingCache(now);
  const existing = runtimeBindingCache.get(key);
  if (existing) {
    existing.lastUsedAt = now;
    // Map insertion order is the LRU order.
    runtimeBindingCache.delete(key);
    runtimeBindingCache.set(key, existing);
    return existing.client;
  }

  const ready = runtimeBindingRetirements.get(key);
  const oldest = runtimeBindingCache.entries().next().value as
    [string, RuntimeBindingCacheEntry] | undefined;
  if (
    runtimeBindingCache.size >= RUNTIME_BINDING_CACHE_MAX_ENTRIES &&
    oldest &&
    !canRememberRuntimeBindingRetirement(oldest[0])
  ) {
    // Keep all unsettled gates. A caller gets an uncached client until one
    // settles, so cache admission cannot grow process state or drop ordering.
    return createRuntimeBindingClient({
      ...options,
      endpoint,
      projectKey,
      ...(ready ? { ready } : {}),
    });
  }
  const client = createRuntimeBindingClient({
    ...options,
    endpoint,
    projectKey,
    ...(ready ? { ready } : {}),
  });
  runtimeBindingCache.set(key, { client, lastUsedAt: now });
  while (runtimeBindingCache.size > RUNTIME_BINDING_CACHE_MAX_ENTRIES) {
    const oldest = runtimeBindingCache.entries().next().value as
      [string, RuntimeBindingCacheEntry] | undefined;
    if (!oldest) break;
    runtimeBindingCache.delete(oldest[0]);
    oldest[1].client.stop();
    rememberRuntimeBindingRetirement(oldest[0], oldest[1].client);
  }
  return client;
}

function functionIdentity(value: object | undefined): number {
  if (!value) return 0;
  const existing = runtimeBindingFunctionIds.get(value);
  if (existing !== undefined) return existing;
  const identity = nextRuntimeBindingFunctionId++;
  runtimeBindingFunctionIds.set(value, identity);
  return identity;
}

/** Test-only cleanup for module-cache lifecycle assertions. */
export function __resetRuntimeBindingCacheForTests(): void {
  for (const entry of runtimeBindingCache.values()) entry.client.stop();
  runtimeBindingCache.clear();
  runtimeBindingRetirements.clear();
}

function pruneRuntimeBindingCache(now: number): void {
  for (const [key, entry] of runtimeBindingCache) {
    if (now - entry.lastUsedAt <= RUNTIME_BINDING_CACHE_TTL_MS) continue;
    if (!canRememberRuntimeBindingRetirement(key)) continue;
    entry.client.stop();
    rememberRuntimeBindingRetirement(key, entry.client);
    runtimeBindingCache.delete(key);
  }
}

function canRememberRuntimeBindingRetirement(key: string): boolean {
  return (
    runtimeBindingRetirements.has(key) ||
    runtimeBindingRetirements.size < RUNTIME_BINDING_MAX_PENDING_RETIREMENTS
  );
}

function rememberRuntimeBindingRetirement(
  key: string,
  client: RuntimeBindingClient,
): void {
  const clientRetirement = client.getRetirement();
  const previousRetirement = runtimeBindingRetirements.get(key);
  const retirement = previousRetirement
    ? Promise.all([previousRetirement, clientRetirement]).then(() => undefined)
    : clientRetirement;
  runtimeBindingRetirements.set(key, retirement);
  void retirement.then(() => {
    if (runtimeBindingRetirements.get(key) === retirement)
      runtimeBindingRetirements.delete(key);
  });
}

function parseRuntimeBinding(
  value: RuntimeBindingResponse,
  now: number,
): RuntimeBinding | undefined {
  if (
    typeof value.instanceId !== "string" ||
    !/^ri_[A-Za-z0-9_-]{8,128}$/u.test(value.instanceId) ||
    typeof value.instanceProof !== "string" ||
    !/^\S{32,512}$/u.test(value.instanceProof) ||
    typeof value.expiresAt !== "string"
  )
    return undefined;
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return undefined;
  return {
    instanceId: value.instanceId,
    instanceProof: value.instanceProof,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  return undefined;
}

function resolveOrigin(value: string): string | undefined {
  try {
    return new URL(
      value,
      typeof location !== "undefined" ? location.href : "http://localhost/",
    ).origin;
  } catch {
    return undefined;
  }
}
