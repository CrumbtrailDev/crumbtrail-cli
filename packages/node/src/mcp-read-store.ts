import { defaultSessionStore } from "./session-store";

/**
 * What a store already knows about a session without reading an artifact.
 *
 * A remote listing answers with these fields on the wire, so a caller that only
 * needs a row's shape must not pay a second request per session to rebuild
 * them. A local store leaves the summary undefined, because reading meta.json
 * off disk costs nothing and the numbers live only inside the artifacts.
 */
export interface McpSessionSummary {
  /** The service the session was ingested under. NOT the SDK's `app`: that
   *  lives in meta.json and the two are set from different fields. */
  service?: string;
  start?: number;
  end?: number;
  errorCount?: number;
  failedRequestCount?: number;
  title?: string;
}

export interface McpSessionEntry {
  id: string;
  dir: string;
  /** Undefined when the store cannot answer without reading artifacts. */
  summary?: McpSessionSummary;
}

/** Filters a store may push at its backend instead of making the caller scan. */
export interface McpSessionQuery {
  /** Rows wanted. A store answers at most this many and says if more matched. */
  limit?: number;
  /** Epoch ms lower bound on session start. */
  after?: number;
  /** Epoch ms upper bound on session start. */
  before?: number;
  release?: string;
}

/**
 * Why a listing could not be answered in full.
 *
 * This exists because the alternative was silence: a 429 from the read limiter,
 * an expired token and a network failure all used to collapse to an empty list,
 * which the tools reported as "you have no sessions". A reader cannot act on
 * that. Each of these is a different next step for them.
 */
export interface McpSessionListingFailure {
  reason: "read_quota_exhausted" | "unauthorized" | "unreachable";
  retryAfterSeconds?: number;
}

export interface McpSessionListing {
  /** Everything that was read, which may be a prefix of what matched. */
  sessions: McpSessionEntry[];
  /** True when more sessions matched than were returned. */
  truncated: boolean;
  /** Set when the listing stopped early. `sessions` is then partial. */
  unavailable?: McpSessionListingFailure;
}

export interface McpReadStore {
  listSessions(query?: McpSessionQuery): Promise<McpSessionListing>;
  resolveSessionDir(sessionId: string): Promise<string>;
  readArtifact(sessionDir: string, name: string): Promise<Buffer | undefined>;
  statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined>;
}

export class FilesystemMcpReadStore implements McpReadStore {
  constructor(private readonly outputDir: string) {}

  /**
   * The query is deliberately not pushed down. Every filter it carries is
   * answered by meta.json, which is a local file read the caller is going to
   * make anyway, so filtering here would cost the same reads and lose the
   * caller's ability to fall back on aliases (release/releaseId/version). The
   * remote store is where a pushed down filter buys anything.
   */
  async listSessions(): Promise<McpSessionListing> {
    const sessions = await defaultSessionStore.listSessions(this.outputDir);
    return { sessions, truncated: false };
  }

  // resolveSessionDir stays SYNC on the store (pure path resolution, no artifact
  // bytes cross it), so this async wrapper simply returns its value.
  // eslint-disable-next-line @typescript-eslint/require-await
  async resolveSessionDir(sessionId: string): Promise<string> {
    return defaultSessionStore.resolveSessionDir(sessionId, this.outputDir);
  }

  async readArtifact(
    sessionDir: string,
    name: string,
  ): Promise<Buffer | undefined> {
    return defaultSessionStore.readArtifact(sessionDir, name);
  }

  async statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined> {
    return defaultSessionStore.statArtifact(sessionDir, name);
  }
}

interface RemoteMcpReadStoreConfig {
  baseUrl: string;
  token: string;
  /** Test seam for a short failure budget; production uses 15 seconds. */
  timeoutMs?: number;
}

export class RemoteMcpReadStore implements McpReadStore {
  private static readonly MAX_BODY_BYTES = 16 * 1024 * 1024;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor({
    baseUrl,
    token,
    timeoutMs = 15_000,
  }: RemoteMcpReadStoreConfig) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One bounded, filtered request instead of a full scan.
   *
   * This used to page `/api/agent/sessions` up to fifty times, forward none of
   * the filters the route parses, and throw away every field but the id, which
   * forced each caller into one artifact read per session to rebuild what had
   * already been on the wire. On a tenant with a few hundred sessions that
   * exhausted the agent read limiter inside a single tool call, and the 429
   * came back as an empty list.
   *
   * So: the filters go in the query string, the limit bounds the request rather
   * than the output, the payload's own per session numbers are kept, and a
   * failure is reported as a failure with whatever was read before it.
   */
  async listSessions(query: McpSessionQuery = {}): Promise<McpSessionListing> {
    const wanted = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const sessions: McpSessionEntry[] = [];

    // One row past what the caller asked for, so a full page is distinguishable
    // from a page that happens to end exactly on the limit.
    while (sessions.length <= wanted) {
      const page = Math.min(100, wanted + 1 - sessions.length);
      const result = await this.fetchSessionPage(
        query,
        page,
        sessions.length,
      );
      if (!result.ok) {
        return { sessions, truncated: false, unavailable: result.failure };
      }
      sessions.push(...result.sessions);
      // A short PAGE ends the listing, not a short mapped result: a row the
      // client could not parse still consumed one of the rows the server had.
      if (result.rowCount < page) {
        return { sessions, truncated: false };
      }
    }
    return { sessions: sessions.slice(0, wanted), truncated: true };
  }

  private sessionListPath(
    query: McpSessionQuery,
    limit: number,
    offset: number,
  ): string {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    // The route reads these as `since`/`until` ISO timestamps and as an exact
    // release tag. Anything it cannot parse it ignores, so an unusable bound is
    // never sent rather than silently widening the read.
    const since = isoOrUndefined(query.after);
    if (since) params.set("since", since);
    const until = isoOrUndefined(query.before);
    if (until) params.set("until", until);
    const release = query.release?.trim();
    if (release) params.set("release", release);
    return `/api/agent/sessions?${params.toString()}`;
  }

  private async fetchSessionPage(
    query: McpSessionQuery,
    limit: number,
    offset: number,
  ): Promise<
    | { ok: true; sessions: McpSessionEntry[]; rowCount: number }
    | { ok: false; failure: McpSessionListingFailure }
  > {
    const path = this.sessionListPath(query, limit, offset);
    const response = await this.fetchListing(path);
    if (!response.ok) return { ok: false, failure: response.failure };
    let payload: unknown;
    try {
      payload = JSON.parse(response.body.toString("utf-8"));
    } catch {
      return { ok: false, failure: { reason: "unreachable" } };
    }
    const rows = isRecord(payload) ? payload.sessions : undefined;
    if (!Array.isArray(rows)) {
      return { ok: false, failure: { reason: "unreachable" } };
    }
    return {
      ok: true,
      sessions: rows.map(toSessionEntry).filter(isEntry),
      rowCount: rows.length,
    };
  }

  /**
   * Fetches a listing and keeps the status, because the status IS the answer
   * here. `fetchBody` collapses every non ok response to undefined, which is
   * right for an artifact (missing or unreadable are the same next step) and
   * wrong for a listing (quota, auth and outage are three different ones).
   */
  private async fetchListing(
    path: string,
  ): Promise<
    | { ok: true; body: Buffer }
    | { ok: false; failure: McpSessionListingFailure }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!response.ok || this.exceedsBodyLimit(response)) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, failure: listingFailure(response) };
      }
      const body = await this.readBoundedBody(response);
      return body === undefined
        ? { ok: false, failure: { reason: "unreachable" } }
        : { ok: true, body };
    } catch {
      return { ok: false, failure: { reason: "unreachable" } };
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolveSessionDir(sessionId: string): Promise<string> {
    return sessionId;
  }

  async readArtifact(
    sessionId: string,
    name: string,
  ): Promise<Buffer | undefined> {
    return this.fetchBody(this.artifactPath(sessionId, name));
  }

  async statArtifact(
    sessionId: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined> {
    const path = this.artifactPath(sessionId, name);
    const head = await this.fetchHead(path);
    if (!head) return undefined;

    const headerBytes = this.contentLength(head);
    if (headerBytes !== undefined) {
      return headerBytes <= RemoteMcpReadStore.MAX_BODY_BYTES
        ? { bytes: headerBytes, isDir: false }
        : undefined;
    }

    // No Content-Length came back, so the endpoint answered with chunked
    // framing and the size is only knowable by downloading the artifact. This
    // fallback pays for a SECOND request and streams the whole body just to
    // measure it, so it is a real cost, not a formality: it stays bounded and
    // timed rather than trusting an unbounded response.
    //
    // Crumbtrail's own cloud declares the length and takes the cheap path
    // above; it did not always, and the omission silently doubled every stat.
    // This path is for endpoints that still omit the header.
    const bytes = await this.fetchBody(path, "byteLength");
    return bytes === undefined ? undefined : { bytes, isDir: false };
  }

  /**
   * Statuses that mean "this endpoint will not answer a HEAD", as opposed to
   * "this artifact is not there".
   *
   * 404 is in here because of how the agent router used to behave: it rejected
   * every non GET before resolving the token, so the request fell through to
   * the catch all and a HEAD stat came back 404 — indistinguishable from a
   * missing artifact. A cloud old enough to do that still answers the same GET
   * stat this client used to send, so a 404 HEAD must be retried as a GET
   * rather than reported as absence. 405 and 501 cover intermediaries that
   * refuse the method outright.
   */
  private static readonly HEAD_UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

  private artifactPath(sessionId: string, name: string): string {
    return `/api/agent/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(name)}`;
  }

  /**
   * Stats an artifact by asking for its headers, preferring HEAD.
   *
   * HEAD is the honest way to ask: the cloud audits it as a `stat` rather than
   * as a read, because no body is served. The GET stat this used to send is
   * indistinguishable from a real read at the server, so it books a read audit
   * row for evidence the agent never receives — and the row is written before
   * the body, so cancelling the stream cannot take it back. One session
   * existence check stats six artifacts, so that was six phantom rows per
   * check on a compliance surface.
   *
   * GET remains the fallback for a cloud that does not serve HEAD, so this
   * client keeps working against an older deployment. See
   * HEAD_UNSUPPORTED_STATUSES for why a 404 is treated as "no HEAD here"
   * rather than "no artifact".
   */
  private async fetchHead(path: string): Promise<Response | undefined> {
    const head = await this.fetchHeaders(path, "HEAD");
    // A transport failure or a blown deadline, which a second request would
    // only pay for twice.
    if (head === undefined) return undefined;
    if (head.status === 200) return head;
    if (!RemoteMcpReadStore.HEAD_UNSUPPORTED_STATUSES.has(head.status)) {
      return undefined;
    }
    const get = await this.fetchHeaders(path, "GET");
    return get?.status === 200 ? get : undefined;
  }

  /**
   * Fetches one response and discards any body, returning it whatever the
   * status so the caller can tell the statuses apart.
   *
   * fetch() resolves at the headers, so this only pays for the header round
   * trip — but a GET body MUST be cancelled here rather than buffered, or a
   * stalled or oversized artifact would hang the stat or hold the socket open.
   */
  private async fetchHeaders(
    path: string,
    method: "HEAD" | "GET",
  ): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      const artifact = await this.followDirectArtifactHandoff(
        path,
        method,
        response,
        controller.signal,
      );
      if (!artifact) return undefined;
      // Headers are all this stat consumes; drop the body without reading it.
      void artifact.body?.cancel().catch(() => undefined);
      return artifact;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private fetchBody(path: string): Promise<Buffer | undefined>;
  private fetchBody(
    path: string,
    mode: "byteLength",
  ): Promise<number | undefined>;
  private async fetchBody(
    path: string,
    mode: "buffer" | "byteLength" = "buffer",
  ): Promise<Buffer | number | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      const artifact = await this.followDirectArtifactHandoff(
        path,
        "GET",
        response,
        controller.signal,
      );
      if (!artifact || !artifact.ok || this.exceedsBodyLimit(artifact)) {
        void artifact?.body?.cancel().catch(() => undefined);
        return undefined;
      }
      return mode === "buffer"
        ? await this.readBoundedBody(artifact)
        : await this.readBoundedBodyByteLength(artifact);
    } catch {
      return undefined;
    } finally {
      // The deadline deliberately remains armed while the response stream is
      // consumed. fetch() only resolves at headers, while a body can stall.
      clearTimeout(timeout);
    }
  }

  /**
   * Hosted artifact routes authenticate the agent then return a short lived
   * edge URL and header grant. The actual bytes are fetched directly from the
   * edge so Railway never becomes the artifact data path.
   */
  private async followDirectArtifactHandoff(
    path: string,
    method: "GET" | "HEAD",
    response: Response,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    if (response.headers.get("x-crumbtrail-artifact-read") !== "direct") {
      return response;
    }
    // A HEAD response has no body, so make one authenticated metadata request
    // to obtain the handoff before sending HEAD to the edge.
    const handoffResponse = method === "HEAD"
      ? await globalThis.fetch(`${this.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal,
        })
      : response;
    if (!handoffResponse.ok) return undefined;
    let handoff: unknown;
    try {
      handoff = await handoffResponse.json();
    } catch {
      return undefined;
    }
    if (!isDirectArtifactHandoff(handoff)) return undefined;
    try {
      return await globalThis.fetch(handoff.url, {
        method,
        headers: { Authorization: handoff.authorization },
        signal,
      });
    } catch {
      return undefined;
    }
  }

  private contentLength(response: Response): number | undefined {
    const value = response.headers.get("content-length");
    if (value === null) return undefined;
    const bytes = Number(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }

  private exceedsBodyLimit(response: Response): boolean {
    const bytes = this.contentLength(response);
    return bytes !== undefined && bytes > RemoteMcpReadStore.MAX_BODY_BYTES;
  }

  private async readBoundedBody(
    response: Response,
  ): Promise<Buffer | undefined> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RemoteMcpReadStore.MAX_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      reader.releaseLock();
    }
  }

  private async readBoundedBodyByteLength(
    response: Response,
  ): Promise<number | undefined> {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return bytes;
        bytes += value.byteLength;
        if (bytes > RemoteMcpReadStore.MAX_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isoOrUndefined(epochMs: number | undefined): string | undefined {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function epochOrUndefined(value: unknown): number | undefined {
  const direct = finiteNumber(value);
  if (direct !== undefined) return direct;
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Keeps the per session numbers the listing already carried. Before this they
 * were dropped on the floor and re fetched one artifact at a time.
 */
function toSessionEntry(row: unknown): McpSessionEntry | undefined {
  if (!isRecord(row)) return undefined;
  const id = nonEmptyString(row.id);
  if (!id) return undefined;
  const summary: McpSessionSummary = {
    service: nonEmptyString(row.serviceName),
    start: epochOrUndefined(row.startedAt),
    end: epochOrUndefined(row.finalizedAt),
    errorCount: finiteNumber(row.errorCount),
    failedRequestCount: finiteNumber(row.failedRequestCount),
    title: nonEmptyString(row.title),
  };
  return { id, dir: id, summary };
}

function isEntry(entry: McpSessionEntry | undefined): entry is McpSessionEntry {
  return entry !== undefined;
}

/**
 * A 429 is the read limiter, and it is the one failure with a stated recovery,
 * so its Retry-After travels with it. 401/403 is a token the operator has to
 * replace. Everything else is an outage from the caller's point of view.
 */
function listingFailure(response: Response): McpSessionListingFailure {
  if (response.status === 429) {
    const header = Number(response.headers.get("retry-after"));
    return {
      reason: "read_quota_exhausted",
      ...(Number.isFinite(header) && header >= 0
        ? { retryAfterSeconds: header }
        : {}),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { reason: "unauthorized" };
  }
  return { reason: "unreachable" };
}

interface DirectArtifactHandoff {
  handoff: "artifact.v2";
  url: string;
  authorization: string;
}

function isDirectArtifactHandoff(value: unknown): value is DirectArtifactHandoff {
  if (value == null || typeof value !== "object") return false;
  const handoff = value as Record<string, unknown>;
  return (
    handoff.handoff === "artifact.v2" &&
    typeof handoff.url === "string" &&
    typeof handoff.authorization === "string" &&
    handoff.authorization.startsWith("Bearer ")
  );
}

export function selectMcpReadStore(outputDir: string): McpReadStore {
  const baseUrl = process.env.CRUMBTRAIL_CLOUD_URL;
  const token = process.env.CRUMBTRAIL_CLOUD_TOKEN;
  if (Boolean(baseUrl) !== Boolean(token)) {
    throw new Error(
      "CRUMBTRAIL_CLOUD_URL and CRUMBTRAIL_CLOUD_TOKEN must be configured together for MCP cloud reads.",
    );
  }
  if (baseUrl && token) return new RemoteMcpReadStore({ baseUrl, token });
  return new FilesystemMcpReadStore(outputDir);
}
