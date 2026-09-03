import type { BugEvent, CrumbtrailTransport, BugReport } from "../types";

/**
 * A batch the server refused.
 *
 * `fetch` resolves for 4xx and 5xx alike, so a transport that only catches
 * thrown errors treats "payload too large" and "rate limited" as delivery. The
 * events are dropped, nothing records it, and the resulting session is
 * indistinguishable from one where nothing happened. Throwing lets the caller
 * declare the hole.
 */
export class EventDeliveryError extends Error {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly eventCount: number;

  constructor(status: number, eventCount: number) {
    super(
      status > 0
        ? `capture endpoint rejected ${eventCount} event(s) with ${status}`
        : `capture endpoint unreachable for ${eventCount} event(s)`,
    );
    this.name = "EventDeliveryError";
    this.status = status;
    this.eventCount = eventCount;
  }
}

/**
 * A stored object the server refused.
 *
 * Separate from {@link EventDeliveryError} because it carries no event count: a
 * blob is one artifact, and reporting it as "rejected 0 events" would read as a
 * refusal that cost nothing.
 */
export class BlobDeliveryError extends Error {
  readonly status: number;
  readonly objectName: string;

  constructor(objectName: string, status: number) {
    super(`capture endpoint refused ${objectName} with ${status}`);
    this.name = "BlobDeliveryError";
    this.status = status;
    this.objectName = objectName;
  }
}

/**
 * A session lifecycle call the server refused.
 *
 * Separate from {@link EventDeliveryError} because the loss is not a batch, it
 * is the session: `/api/session/start` answering 402, 409 or 429 means no
 * session row exists, so every later `/api/events` post for that id is refused
 * too — including the capture gap events that would have declared the hole.
 */
export class SessionDeliveryError extends Error {
  readonly status: number;
  readonly phase: "start" | "end";

  constructor(phase: "start" | "end", status: number) {
    super(`capture endpoint refused session ${phase} with ${status}`);
    this.name = "SessionDeliveryError";
    this.status = status;
    this.phase = phase;
  }
}

/**
 * A bug report the server refused.
 *
 * The one payload a human deliberately created. Every other refusal is a
 * statistic; this one is a person who was told their report was filed.
 */
export class BugReportDeliveryError extends Error {
  readonly status: number;
  readonly bugId: string;
  /** `"report"` for the flag itself, `"voice"` for the follow-up upload. */
  readonly part: "report" | "voice";

  constructor(bugId: string, part: "report" | "voice", status: number) {
    super(`capture endpoint refused bug ${part} ${bugId} with ${status}`);
    this.name = "BugReportDeliveryError";
    this.status = status;
    this.bugId = bugId;
    this.part = part;
  }
}

/**
 * The server accepted the request and discarded the evidence.
 *
 * `/api/events` answers `202 {ok:true, capture:"shed", reason, retryAfterSeconds}`
 * when a project's capture budget is spent or its kill switch is on. 202 is
 * `response.ok`, so a transport that only tests `ok` reads a discard as a
 * delivery and keeps flushing at full rate into a project that is storing
 * nothing. Modelled as a delivery failure because that is what it is: the
 * events are gone, and the caller records the gap the same way.
 */
export class CaptureShedError extends EventDeliveryError {
  /** The server's own shed reason (`kill_switch`, `bytes_per_day`, ...). */
  readonly reason: string;
  readonly retryAfterSeconds: number;

  constructor(eventCount: number, reason: string, retryAfterSeconds: number) {
    super(202, eventCount);
    this.name = "CaptureShedError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface HttpTransportOptions {
  authToken?: string;
}

/**
 * Browsers cap the total in-flight `keepalive` request body budget at 64 KiB
 * and reject oversized bodies outright. Stay under a conservative 60 KB so a
 * batch never fails just because it asked to outlive the page; bigger batches
 * fall back to a plain fetch.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Exact UTF-8 byte length via TextEncoder (available in every browser and
 * Node release we support). The `String.length` fallback counts UTF-16 code
 * units, which under-counts multi-byte characters; the 60 KB budget vs the
 * 64 KiB browser cap absorbs that slack for our mostly-ASCII JSON payloads.
 */
/**
 * The cloud reads `/api/events` with a hard 1 MiB body cap and answers 413 for
 * anything over it. Batching was by event count only (100 events), so a batch
 * carrying captured bodies or a view tree crossed the cap routinely and was
 * dropped whole — and dropped again on the next flush, and the next, for as
 * long as the payloads stayed large. Stay under the cap with headroom for the
 * envelope so the split is decided here rather than by a refusal.
 */
const MAX_EVENTS_BODY_BYTES = 1_000_000;

/**
 * How far a 413 may be bisected before a single event is declared unsendable.
 *
 * A batch that is too large is halved and retried, which recovers everything
 * except the one oversized event. Bounded so a server answering 413 to
 * everything cannot turn one flush into an unbounded fan of requests.
 */
const MAX_BISECT_DEPTH = 6;

/**
 * A receiver running on this machine — `crumbtrail-node`, which accepts
 * unauthenticated sessions on purpose. Used only to decide whether a missing
 * ingest key is worth a console line: on a local receiver it is normal, and
 * anywhere else it means nothing will be captured.
 */
function isLocalEndpoint(endpoint: string): boolean {
  let host = "";
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  );
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

export class HttpTransport implements CrumbtrailTransport {
  private sessionId = "";
  private authToken?: string;
  private endpoint: string;
  /**
   * Status of a refused `/api/session/start`, or 0 when the session is live.
   *
   * A refused start leaves no session row, so every subsequent `/api/events`
   * post is answered 404 — including the capture gaps about the failure. The
   * transport refuses locally instead: the caller records the same gap it would
   * have recorded, at once, and the page stops spending bandwidth on a session
   * the server never opened. Cleared by a start that succeeds, so an identity
   * refresh recovers.
   */
  private startRefusedStatus = 0;
  /**
   * Settles when the in-flight `/api/session/start` has been answered.
   *
   * The server creates the sessions row inside that request, so anything sent
   * before it lands names a session the server has never heard of and is
   * answered `404 Session not found` — the console line an integrator reads as
   * "capture is broken" while the session is in fact starting normally. The
   * flush interval is not a guarantee: a burst that fills the batch buffer
   * flushes immediately, and on a real network the start round trip is the
   * slower of the two. Every send therefore waits for this first.
   *
   * Never rejects. A refused start is remembered by `startRefusedStatus` and
   * answered locally by `standingRefusal`, which is the caller's signal to
   * record the gap; a rejection here would turn that into an unhandled one.
   */
  private sessionReady: Promise<void> = Promise.resolve();
  /** Epoch ms until which the server has asked us to stop sending. */
  private shedUntil = 0;
  /** The server's reason for the active shed, for the gap the caller records. */
  private shedReason = "";
  private warned = new Set<string>();

  constructor(endpoint: string, options?: HttpTransportOptions) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.authToken = options?.authToken;
    if (!this.authToken && !isLocalEndpoint(this.endpoint)) {
      // The one line that closes the commonest cold-start dead end.
      //
      // Every wizard-written init reads its key from an environment variable,
      // and a bundler resolves that variable when the dev server BOOTS. A dev
      // server that was already running when the key was written therefore
      // compiles `undefined` into the bundle, sends every request unauthorized,
      // and gets a 401 on session start. The refusal warning below does fire,
      // but only once traffic happens and without naming the cause, so the
      // integrator sees a working app, an empty dashboard, and no reason.
      //
      // A local receiver is exempt: `crumbtrail-node` accepts unauthenticated
      // sessions by design, so warning there would be noise on every dev boot.
      this.warnOnce(
        "no-auth-token",
        `Crumbtrail.init() received no ingest key (httpAuthToken is undefined), so ${this.endpoint} will refuse this session and nothing will be captured. The key normally comes from an environment variable that your bundler or runtime reads at STARTUP — set it in your env file and restart the dev server, because a server that is already running will not pick up a new value.`,
      );
    }
  }

  private withAuthHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    if (!this.authToken) return headers;
    return { ...headers, "X-Crumbtrail-Auth": this.authToken };
  }

  /**
   * One line, once per distinct condition.
   *
   * An integrator with a revoked ingest key previously saw a working SDK and an
   * empty dashboard, with no signal on either side. Never throws: a transport
   * that breaks the host page because its console is unusual is worse than the
   * silence it replaces.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`[crumbtrail] ${message}`);
      }
    } catch {
      // A host that has replaced console must not take the SDK down with it.
    }
  }

  /**
   * The one line a cold start needs.
   *
   * A wrong endpoint, an ad blocker, a CSP rule and a CORS refusal all reject
   * the `fetch` itself, so none of them reach a status code and none of them
   * used to print anything. The integrator saw a clean console, a passing
   * health check and an empty dashboard, with nothing to tell them apart.
   */
  private warnUnreachable(what: string): void {
    this.warnOnce(
      "unreachable",
      `could not reach the capture endpoint at ${this.endpoint} while sending ${what}, so nothing is being captured. A wrong endpoint, a stopped local server, an ad blocker, a CSP rule or a CORS refusal all fail this way.`,
    );
  }

  /** The refusal already known before a batch is even serialized, if any. */
  private standingRefusal(eventCount: number): EventDeliveryError | undefined {
    if (this.startRefusedStatus > 0) {
      return new EventDeliveryError(this.startRefusedStatus, eventCount);
    }
    if (this.shedUntil > Date.now()) {
      return new CaptureShedError(
        eventCount,
        this.shedReason,
        Math.max(1, Math.ceil((this.shedUntil - Date.now()) / 1000)),
      );
    }
    return undefined;
  }

  async sendEvents(events: BugEvent[]): Promise<void> {
    if (events.length === 0) return;
    const sessionId = this.sessionId;
    const sessionReady = this.sessionReady;
    await sessionReady;
    // A lifecycle rollover can replace both identity and admission while this batch waits. The
    // events belong to the visit active at invocation, so never relabel them as part of the new
    // visit. The old session is already closing and owns its final flush.
    if (sessionId !== this.sessionId) return;
    const standing = this.standingRefusal(events.length);
    if (standing) throw standing;
    await this.deliverAll(this.splitToBudget(events, sessionId), 0, sessionId);
  }

  /**
   * Greedy halving until every chunk's serialized body fits the cap.
   *
   * The body is measured, never estimated: an event's wire size depends on its
   * captured payload, so a per-event guess is the thing that lets an oversized
   * batch out of the door in the first place. A single event that cannot fit is
   * still returned — it is refused by the server rather than dropped silently
   * here, so the loss is recorded with a status.
   */
  private splitToBudget(events: BugEvent[], sessionId: string): BugEvent[][] {
    if (events.length <= 1) return [events];
    if (
      utf8ByteLength(this.eventsBody(events, sessionId)) <=
      MAX_EVENTS_BODY_BYTES
    ) {
      return [events];
    }
    const mid = Math.ceil(events.length / 2);
    return [
      ...this.splitToBudget(events.slice(0, mid), sessionId),
      ...this.splitToBudget(events.slice(mid), sessionId),
    ];
  }

  /**
   * Post every chunk, then report the total loss rather than the first one.
   *
   * A caller turns the thrown error straight into a capture gap sized by
   * `eventCount`, so reporting only the first failed chunk would understate a
   * flush that lost several.
   */
  private async deliverAll(
    chunks: BugEvent[][],
    depth = 0,
    sessionId = this.sessionId,
  ): Promise<void> {
    let first: EventDeliveryError | undefined;
    let lost = 0;
    for (const chunk of chunks) {
      if (sessionId !== this.sessionId) return;
      try {
        await this.deliverChunk(chunk, depth, sessionId);
      } catch (error) {
        const failure =
          error instanceof EventDeliveryError
            ? error
            : new EventDeliveryError(0, chunk.length);
        lost += failure.eventCount;
        first ??= failure;
      }
    }
    if (!first) return;
    // Rethrow the original when it accounts for the whole loss, so a shed keeps
    // its reason and its Retry-After all the way to the caller.
    throw first.eventCount === lost
      ? first
      : new EventDeliveryError(first.status, lost);
  }

  /**
   * One chunk, bisected on a 413.
   *
   * The cap is a body size, not an event count, so half a refused batch is
   * usually acceptable. Dropping the whole batch instead threw away every event
   * that would have fit alongside the one oversized payload.
   */
  private async deliverChunk(
    events: BugEvent[],
    depth: number,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.postEvents(events, sessionId);
    } catch (error) {
      const oversized =
        error instanceof EventDeliveryError &&
        error.status === 413 &&
        events.length > 1 &&
        depth < MAX_BISECT_DEPTH;
      if (!oversized) throw error;
      const mid = Math.ceil(events.length / 2);
      await this.deliverAll(
        [events.slice(0, mid), events.slice(mid)],
        depth + 1,
        sessionId,
      );
    }
  }

  private eventsBody(events: BugEvent[], sessionId = this.sessionId): string {
    return JSON.stringify({ sessionId, events });
  }

  /**
   * `sendBeacon` cannot set headers. The ingest key is already public in a
   * browser bundle, so the two eligible unload routes accept it in this JSON
   * envelope instead. Keep it out of ordinary fetch bodies and never put it in
   * the URL, where proxies and access logs would retain it.
   */
  private beaconBody(body: string): string {
    if (!this.authToken) return body;
    return JSON.stringify({
      ...(JSON.parse(body) as Record<string, unknown>),
      ingestKey: this.authToken,
    });
  }

  private async postEvents(
    events: BugEvent[],
    sessionId: string,
  ): Promise<void> {
    if (sessionId !== this.sessionId) return;
    const body = this.eventsBody(events, sessionId);
    const init: RequestInit = {
      method: "POST",
      headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
      body,
    };
    // keepalive lets the request outlive the page (pagehide/tab close), but
    // only bodies under the browser's keepalive budget may opt in.
    if (utf8ByteLength(body) <= KEEPALIVE_MAX_BYTES) init.keepalive = true;
    let response: Response | undefined;
    try {
      response = await fetch(`${this.endpoint}/api/events`, init);
    } catch {
      // During teardown fetch can be torn down mid-flight; sendBeacon is queued
      // by the browser and survives unload. It carries the public ingest key in
      // the JSON body because a beacon cannot carry a request header.
      this.warnUnreachable("captured events");
      // The return value matters. A page that logs in a tight loop exhausts the
      // browser's in-flight request budget, every fetch rejects, and the beacon
      // queue is full too — so `sendBeacon` answers false and the batch is
      // simply gone. Swallowing that is how a session drops most of a burst and
      // still reports itself complete.
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([this.beaconBody(body)], {
          type: "application/json",
        });
        if (navigator.sendBeacon(`${this.endpoint}/api/events`, blob)) return;
      }
      throw new EventDeliveryError(0, events.length);
    }
    // 202 with `capture:"shed"` is an acceptance of the request and a discard
    // of its contents. The server sends Retry-After specifically so the client
    // can stop; honour it rather than flushing at full rate into a project that
    // is storing nothing.
    if (response.status === 202) {
      const shed = await readShedResponse(response);
      if (shed) {
        this.shedReason = shed.reason;
        this.shedUntil = Date.now() + shed.retryAfterSeconds * 1000;
        this.warnOnce(
          `shed:${shed.reason}`,
          `capture is being shed by the server (${shed.reason}); pausing for ${shed.retryAfterSeconds}s`,
        );
        throw new CaptureShedError(
          events.length,
          shed.reason,
          shed.retryAfterSeconds,
        );
      }
    }
    // A refusal is not a delivery. Retrying by beacon would be refused the same
    // way, so surface it instead: the caller turns this into a capture gap.
    if (!response.ok) {
      // The server already wrote the sentence that explains this ("A project
      // API key is required", the cap wall, the pause wall). Reporting a bare
      // status instead sent the integrator to guess at a cause the response
      // body was holding.
      const reason = await readRefusalMessage(response);
      this.warnOnce(
        `events:${response.status}`,
        `the capture endpoint refused events with HTTP ${response.status}${reason ? `: ${reason}` : ""}`,
      );
      throw new EventDeliveryError(response.status, events.length);
    }
  }

  async sendBlob(
    name: string,
    blob: Blob,
    metadata?: Record<string, unknown>,
    sessionIdOverride?: string,
  ): Promise<void> {
    const sessionId = sessionIdOverride ?? this.sessionId;
    await this.sessionReady;
    // The session start promise is deliberately non-throwing, so inspect the remembered refusal
    // after it settles. This avoids a second network request for a session the server never
    // admitted, including screenshot uploads that arrive before the first event flush.
    if (this.startRefusedStatus > 0)
      throw new BlobDeliveryError(name, this.startRefusedStatus);
    // A screenshot captures its session id before awaiting encoding or the start request. If a
    // lifecycle rollover changed the transport's active id meanwhile, do not send old evidence
    // into the new session.
    if (sessionIdOverride !== undefined && sessionId !== this.sessionId)
      throw new BlobDeliveryError(name, 0);
    const headers = this.withAuthHeaders({
      // Image artifact routes validate the declared type against their generated
      // name. Keep the historical binary fallback for blobs without a type.
      "Content-Type": blob.type || "application/octet-stream",
      "X-Session-Id": sessionId,
    });
    if (metadata) {
      headers["X-Metadata"] = JSON.stringify(metadata);
    }
    const response = await fetch(`${this.endpoint}/api/blob/${name}`, {
      method: "POST",
      headers,
      body: blob,
    });
    // A refusal is not a delivery. Session replay in particular is refused with
    // 403 by a project that has not opted in, and a caller that read that as
    // success would keep uploading a recording the server is discarding.
    if (!response.ok) throw new BlobDeliveryError(name, response.status);
  }

  async startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.sessionId = sessionId;
    const attempt = this.postSessionStart(sessionId, metadata);
    // Held before awaiting, so a send racing this very call still waits.
    this.sessionReady = attempt.then(
      () => {},
      () => {},
    );
    return attempt;
  }

  private async postSessionStart(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/session/start`, {
        method: "POST",
        headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId, metadata }),
      });
    } catch {
      // The caller swallows this rejection, so this warning is the only trace
      // an unreachable endpoint leaves. It is also the first request the SDK
      // makes, which makes it the earliest possible moment to say so.
      this.warnUnreachable("the session start");
      throw new SessionDeliveryError("start", 0);
    }
    if (response.ok) {
      this.startRefusedStatus = 0;
      return;
    }
    // 402, 409, 429 and 401 all land here, and every one of them means the
    // server holds no session under this id. Recording that is the difference
    // between a session that reports itself healthy for its whole lifetime
    // while nothing lands, and one that says so on the first batch.
    this.startRefusedStatus = response.status;
    const reason = await readRefusalMessage(response);
    this.warnOnce(
      `session-start:${response.status}`,
      `session start was refused with HTTP ${response.status}${reason ? `: ${reason}` : ""}; nothing from this session will be captured`,
    );
    throw new SessionDeliveryError("start", response.status);
  }

  async sendBugReport(
    report: BugReport,
    events: BugEvent[],
    voiceBlob?: Blob,
  ): Promise<void> {
    await this.sessionReady;
    const response = await fetch(`${this.endpoint}/api/bug/flag`, {
      method: "POST",
      headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ report, events }),
    });
    // Refused reports are the one loss a person witnesses: the widget says
    // "Saved" and they walk away. Throwing is what lets it say otherwise.
    if (!response.ok) {
      throw new BugReportDeliveryError(
        report.bugId,
        "report",
        response.status,
      );
    }

    if (voiceBlob) {
      const voiceResponse = await fetch(
        `${this.endpoint}/api/bug/${report.bugId}/voice`,
        {
          method: "POST",
          headers: this.withAuthHeaders({
            "Content-Type": "application/octet-stream",
          }),
          body: voiceBlob,
        },
      );
      if (!voiceResponse.ok) {
        throw new BugReportDeliveryError(
          report.bugId,
          "voice",
          voiceResponse.status,
        );
      }
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const body = JSON.stringify({ sessionId });
    let response: Response | undefined;
    try {
      // `keepalive` is what makes this survive an unload. A plain fetch is
      // cancelled the moment the document goes away. This fetch keeps the
      // header and is well inside the 64KB cap this body uses.
      response = await fetch(`${this.endpoint}/api/session/end`, {
        method: "POST",
        headers: this.withAuthHeaders({ "Content-Type": "application/json" }),
        body,
        keepalive: true,
      });
    } catch {
      // Only reached when keepalive itself is unavailable or refused. A beacon
      // carries the public ingest key in the JSON body because it cannot carry
      // a request header.
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([this.beaconBody(body)], {
          type: "application/json",
        });
        navigator.sendBeacon(`${this.endpoint}/api/session/end`, blob);
      }
      return;
    }
    // Deliberately does NOT throw. `endSession` is the last thing `stop()`
    // does, `stop()` is public API, and a refused close is not worth taking a
    // host application's teardown down with it. Warned so it is visible.
    if (!response.ok) {
      this.warnOnce(
        `session-end:${response.status}`,
        `session end was refused with HTTP ${response.status}; this session will be closed by server side timeout instead`,
      );
    }
  }
}

/**
 * Reads a `202` body, returning the shed it declares or `undefined`.
 *
 * Tolerant on purpose: a 202 that is not a shed (or whose body cannot be read)
 * stays a delivery. Only an explicit `capture:"shed"` turns into back-pressure.
 */
/**
 * The server's own explanation of a refusal.
 *
 * Six distinct causes share one status on the ingest route, and the response
 * body is the only thing that separates them. Echoing it costs one clone and
 * turns "HTTP 401" into the sentence the server already wrote.
 */
async function readRefusalMessage(
  response: Response,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function readShedResponse(
  response: Response,
): Promise<{ reason: string; retryAfterSeconds: number } | undefined> {
  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.capture !== "shed") return undefined;
  const reason =
    typeof record.reason === "string" && record.reason ? record.reason : "shed";
  const fromBody =
    typeof record.retryAfterSeconds === "number" &&
    Number.isFinite(record.retryAfterSeconds)
      ? record.retryAfterSeconds
      : undefined;
  const header = Number(response.headers?.get?.("Retry-After"));
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(fromBody ?? (Number.isFinite(header) ? header : 0) ?? 0) || 1,
  );
  return { reason, retryAfterSeconds };
}
