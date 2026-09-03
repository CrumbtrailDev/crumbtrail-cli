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

/** Keep warm-runtime defaults bounded when one process serves many projects. */
export const RUNTIME_BINDING_CACHE_MAX_ENTRIES = 32;

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

const runtimeBindingCache = new Map<string, RuntimeBindingCacheEntry>();

/**
 * Owns one browser tab or Node process binding.
 *
 * The client itself has no module-level storage. Browser callers create one per
 * runtime, keeping a binding scoped to that tab and preventing a key or proof
 * from one origin or project being reused by another initialization. The
 * serverless default wrapper owns a separate bounded cache keyed by endpoint
 * and project. Node callers can keep one explicit instance across re-establishes.
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

  constructor(options: RuntimeBindingClientOptions) {
    this.endpoint = options.endpoint.trim().replace(/\/+$/, "");
    this.projectKey = options.projectKey?.trim() ?? "";
    this.fetcher =
      options.fetchImpl ??
      (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    this.now = options.now ?? Date.now;
  }

  /**
   * Return a usable binding, registering or rotating at most once per call.
   * Registration failures are intentionally swallowed so old SDK behaviour is
   * preserved when Cloud is unavailable or does not yet expose this route.
   */
  async getBinding(): Promise<RuntimeBinding | undefined> {
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
    const request = this.registerOrRotate(previous, generation);
    this.inFlight = request;
    try {
      const next = await request;
      if (!this.stopped && generation === this.requestGeneration && next)
        this.current = next;
      const fallback =
        generation === this.requestGeneration &&
        this.current &&
        this.isUsable(this.current, this.now())
          ? this.current
          : undefined;
      return this.stopped ? undefined : (next ?? fallback);
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  /** Clear the private proof and prevent late registration responses being adopted. */
  stop(): void {
    this.stopped = true;
    this.requestGeneration += 1;
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
      const response = await fetchWithTimeout(
        fetcher,
        url.toString(),
        {
          method: "POST",
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          cache: "no-store",
        },
        RUNTIME_BINDING_REQUEST_TIMEOUT_MS,
      );
      if (this.stopped || generation !== this.requestGeneration)
        return undefined;
      if (!response.ok) {
        this.armRetry(response);
        // A throttled or unreachable endpoint does not invalidate a proof that
        // remains live. A 401 on rotation does, so the next request falls back
        // to the old untargeted contract until a fresh registration succeeds.
        if (response.status === 401 && previous) this.current = undefined;
        return undefined;
      }
      const payload = (await response.json()) as RuntimeBindingResponse;
      if (this.stopped || generation !== this.requestGeneration)
        return undefined;
      const binding = parseRuntimeBinding(payload, this.now());
      if (!binding) {
        this.armRetry();
        return undefined;
      }
      this.retryAfter = 0;
      return binding;
    } catch (error) {
      if (error instanceof RuntimeBindingTimeoutError) {
        // A timeout is ambiguous. The server may have committed rotation
        // before the client stopped waiting, so the previous proof cannot be
        // used again. Invalidate the generation so a late response is ignored.
        this.current = undefined;
        this.requestGeneration += 1;
      }
      this.armRetry();
      return undefined;
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
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const Controller = globalThis.AbortController;
  const controller =
    typeof Controller === "function" ? new Controller() : undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller?.abort();
      } finally {
        reject(new RuntimeBindingTimeoutError());
      }
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([
      fetcher(input, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      }),
      timeout,
    ]);
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

/**
 * Reuse the default binding for one endpoint and project across warm
 * serverless invocations. Explicit clients bypass this cache so callers retain
 * ownership of their lifecycle. The bounded LRU also keeps a process that
 * serves many projects from retaining every client forever.
 */
export function getCachedRuntimeBindingClient(
  options: RuntimeBindingClientOptions,
): RuntimeBindingClient {
  const endpoint = options.endpoint.trim().replace(/\/+$/, "");
  const projectKey = options.projectKey?.trim() ?? "";
  if (!endpoint || !projectKey) return createRuntimeBindingClient(options);

  const now = options.now?.() ?? Date.now();
  pruneRuntimeBindingCache(now);
  const key = `${endpoint}\u0000${projectKey}`;
  const existing = runtimeBindingCache.get(key);
  if (existing) {
    existing.lastUsedAt = now;
    // Map insertion order is the LRU order.
    runtimeBindingCache.delete(key);
    runtimeBindingCache.set(key, existing);
    return existing.client;
  }

  const client = createRuntimeBindingClient({
    ...options,
    endpoint,
    projectKey,
  });
  runtimeBindingCache.set(key, { client, lastUsedAt: now });
  while (runtimeBindingCache.size > RUNTIME_BINDING_CACHE_MAX_ENTRIES) {
    const oldest = runtimeBindingCache.entries().next().value as
      [string, RuntimeBindingCacheEntry] | undefined;
    if (!oldest) break;
    runtimeBindingCache.delete(oldest[0]);
    oldest[1].client.stop();
  }
  return client;
}

/** Test-only cleanup for module-cache lifecycle assertions. */
export function __resetRuntimeBindingCacheForTests(): void {
  for (const entry of runtimeBindingCache.values()) entry.client.stop();
  runtimeBindingCache.clear();
}

function pruneRuntimeBindingCache(now: number): void {
  for (const [key, entry] of runtimeBindingCache) {
    if (now - entry.lastUsedAt <= RUNTIME_BINDING_CACHE_TTL_MS) continue;
    entry.client.stop();
    runtimeBindingCache.delete(key);
  }
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
