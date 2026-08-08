import {
  redactTokenLikeString,
  redactUrl,
  type BugEvent,
} from "crumbtrail-core";

/**
 * Causal graph module. Pure, deterministic assembly of a typed node/edge graph from the event
 * stream; the output is attached to index.json (index.causalGraph) as the single correlation
 * mechanism. Every field placed on a node is a short REDACTED descriptor: raw URLs, bodies, and
 * input values never land here.
 */

export const CAUSAL_GRAPH_SCHEMA_VERSION = "causal-graph.v2" as const;

/**
 * 15 node kinds. The last three (`state.diff`, `decision`, `thirdparty.call`) are Phase 2
 * reserved: valid members of the union but never emitted by `buildCausalGraph` in CP1.
 */
export type CausalNodeKind =
  | "user.click"
  | "user.input"
  | "user.nav"
  | "net.req"
  | "net.res"
  | "backend.req"
  | "backend.error"
  | "db.write"
  | "otel.span"
  | "otel.log"
  | "frontend.error"
  | "console.error"
  | "state.diff" // Phase 2 reserved
  | "decision" // Phase 2 reserved
  | "thirdparty.call"; // Phase 2 reserved

export type CausalEdgeKind = "request" | "interaction" | "symptom" | "temporal";

export type CausalConfidence = "high" | "medium" | "low";

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  t: number;
  requestId?: string;
  sig?: string;
  /**
   * Backend-plane route: the API path an `backend.req`/`backend.error`/`otel.span` served.
   * Frontend nodes never carry it — see `pageRoute`, which is the browser-plane counterpart.
   * The two are deliberately separate fields: a page route and an API path are different
   * namespaces, and comparing one against the other can only ever return false.
   */
  route?: string;
  /**
   * Frontend-plane route: the path of the navigation this node happened under. Present on
   * browser nodes once a `user.nav` has committed, absent for backend nodes.
   */
  pageRoute?: string;
  brief: string;
  candidateId?: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  kind: CausalEdgeKind;
  confidence: CausalConfidence;
}

export interface CausalGraph {
  schemaVersion: typeof CAUSAL_GRAPH_SCHEMA_VERSION;
  nodes: CausalNode[];
  edges: CausalEdge[];
  /**
   * Browser-local request id -> correlation requestId, for the network requests that carried both.
   *
   * The browser numbers its own requests 1, 2, 3...; the correlation requestId is the 32-hex value
   * the backend and the DB plane also stamp. Nodes are built with the correlated id already
   * substituted (see step 1/2 of {@link buildCausalGraph}), but anything anchored OUTSIDE the graph
   * — every detector anchor, in practice — carries whichever id its own plane had. A browser-plane
   * detector therefore anchors on `"9"` while the request's nodes say `"4b7ecf19..."`, the
   * requestId match in {@link attributeCandidates} finds nothing, and a candidate that names a
   * contradiction between the screen and the response it came from is reported `isolated`.
   *
   * Isolated is not a small error here. It removes the candidate from the incident's thread, so
   * ranking hands the top slot to whatever session-global detector fired loudest, and the bundle
   * leads with a finding from a different route than the one the user reported.
   *
   * Emitted only when non-empty, and read as a pure lookup: an anchor id present here resolves to
   * the correlated id, anything else is passed through untouched.
   */
  requestIdAliases?: Record<string, string>;
}

// --- Confidence / window constants -----------------------------------------------------------
// Sole definition of the correlation window/banding (the legacy post-process chain mechanism that
// once carried an identical copy was retired in CP5).
const WINDOW_MS = 2000;
const HIGH_CONFIDENCE_MS = 500;

/** Two-band form: <=500 high, else medium. */
function confidence2(deltaMs: number): "high" | "medium" {
  return deltaMs <= HIGH_CONFIDENCE_MS ? "high" : "medium";
}

// --- REDACTION HELPERS (local reimplementations of post-process semantics) --------------------
// The post-process safeUrl/safePath/safeDiagnosticString/safeString helpers are non-exported, so
// small local equivalents are used here. They must NEVER let a raw URL/body/input value through.

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 120);
}

function redactPathTokens(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      /^[A-Za-z0-9_-]{16,}$/.test(segment) ? "[REDACTED]" : segment,
    )
    .join("/");
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(redactPathTokens(redactUrl(value, "url").value));
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(
    redactPathTokens(redactTokenLikeString(value, "path").value),
  );
}

/**
 * Path portion of a navigation destination, redacted. The query string is deliberately dropped
 * rather than redacted: it is where identifiers and free text live, and it takes no part in
 * identifying which page a node happened on. A relative or unparseable value falls back to
 * `safePath` on the whole string.
 */
function pagePathOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    // A base is supplied so relative destinations ("/checkout") parse; the origin is discarded.
    return safePath(new URL(trimmed, "https://placeholder.invalid").pathname);
  } catch {
    return safePath(trimmed);
  }
}

function safeDiagnosticString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return redactTokenLikeString(trimmed, "diagnostic").value.slice(0, 120);
}

function safeId(value: unknown): string | undefined {
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Body inspection is a coarse mirror of post-process.ts's isFailedNetworkResponse: a truthy
// application-failure marker or an ok:false payload flags failure.
function isFailedNetworkResponse(event: BugEvent): boolean {
  if (event.k !== "net.res") return false;
  if (typeof event.d.st === "number" && event.d.st >= 400) return true;
  const body = event.d.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (
        isRecord(parsed) &&
        (parsed.ok === false ||
          typeof parsed.error === "string" ||
          typeof parsed.code === "string")
      ) {
        return true;
      }
    } catch {
      // non-JSON body: not a structured application failure
    }
  } else if (
    isRecord(body) &&
    (body.ok === false ||
      typeof body.error === "string" ||
      typeof body.code === "string")
  ) {
    return true;
  }
  return false;
}

// --- Node model ------------------------------------------------------------------------------

interface DerivedNode extends CausalNode {
  /** Original source event kind, kept for edge-rule classification (not serialized). */
  srcKind: string;
  /** True when this net.res node represents a failed response (not serialized). */
  failedRes?: boolean;
  /**
   * Navigation epoch: how many `user.nav` nodes precede this one in time order. Equal epochs
   * mean no navigation happened between two nodes, which is the browser-plane "same context"
   * test. Frontend nodes only; backend nodes keep the sentinel and never compare (not
   * serialized).
   */
  navEpoch: number;
  /** Redacted destination path of a `user.nav` node, used to label its epoch (not serialized). */
  navTo?: string;
}

/** Sentinel epoch for nodes that are not on the browser plane and never take part in the test. */
const NO_NAV_EPOCH = -1;

const CONSOLE_ERROR_KIND = "con";
const DB_DIFF_KIND = "db.diff";
const OTEL_SPAN_KIND = "backend.otel.span";
const OTEL_LOG_KIND = "backend.otel.log";

function consoleIsError(value: unknown): boolean {
  const level = safeString(value)?.toLowerCase();
  if (!level) return false;
  const normalized = level === "error" ? "err" : level;
  return normalized.startsWith("err");
}

/**
 * Maps one BugEvent to a node kind, or undefined when the event is not a causal node. Grounded in
 * the real event-kind strings (post-process.ts / backend-events.ts / otel-adapter.ts).
 */
function nodeKindFor(event: BugEvent): CausalNodeKind | undefined {
  switch (event.k) {
    case "clk":
      return "user.click";
    case "inp":
      return "user.input";
    case "nav":
      return "user.nav";
    case "net.req":
      return "net.req";
    case "net.res":
      return "net.res";
    case "backend.req.start":
    case "backend.req.end":
      return "backend.req";
    case "backend.req.error":
      return "backend.error";
    // Auto-captured uncaught exceptions / unhandled rejections (crumbtrail-node's
    // AUTO_CAPTURE_ERROR_EVENT). Request-less, but still a backend failure, so it
    // maps onto the same backend.error node kind as backend.req.error.
    case "backend.uncaught":
      return "backend.error";
    // Background work. A job carries the requestId of the request that enqueued it, and request
    // edges join on exactly that, so mapping a job onto the backend planes puts it in the same
    // thread as the click it followed rather than in a plane of its own that nothing joins. A
    // failed job is a backend failure by any reading; `backend.uncaught` already sets that
    // precedent for server work that had no request of its own.
    case "backend.job.start":
    case "backend.job.end":
      return "backend.req";
    case "backend.job.error":
      return "backend.error";
    case DB_DIFF_KIND:
      return "db.write";
    case OTEL_SPAN_KIND:
      return "otel.span";
    case OTEL_LOG_KIND:
      return "otel.log";
    case "err":
    case "rej":
      return "frontend.error";
    case CONSOLE_ERROR_KIND:
      return consoleIsError(event.d.lv) ? "console.error" : undefined;
    default:
      return undefined;
  }
}

/**
 * Deterministic per-event disambiguator for node ids -- NEVER an array index. Preference order:
 * requestId (backend/db/otel/network-with-requestId), else browser d.id (network), else spanId
 * (otel), else a redacted content signature. Residual collisions are resolved later by a stable
 * counter derived from a deterministic (t, then partial id) pre-sort.
 */
function disambiguatorFor(event: BugEvent, kind: CausalNodeKind): string {
  const requestId = safeId(event.d.requestId);
  if (requestId) return `r=${requestId}`;
  if (kind === "net.req" || kind === "net.res") {
    const browserId = safeId(event.d.id);
    if (browserId) return `b=${browserId}`;
  }
  if (kind === "otel.span" || kind === "otel.log") {
    const spanId = safeId(event.d.spanId);
    if (spanId) return `s=${spanId}`;
  }
  return `c=${contentSignature(event, kind)}`;
}

function contentSignature(event: BugEvent, kind: CausalNodeKind): string {
  const parts = [kind, routeFor(event) ?? "", sigFor(event, kind) ?? ""];
  return parts.join("|");
}

function routeFor(event: BugEvent): string | undefined {
  return safePath(event.d.route) ?? safePath(event.d.name);
}

function sigFor(event: BugEvent, kind: CausalNodeKind): string | undefined {
  switch (kind) {
    case "net.req":
    case "net.res":
      return safeUrl(event.d.url);
    case "otel.span":
      // Spans carry name/statusMessage (otel-adapter span conversion). Logs do NOT.
      return (
        safePath(event.d.name) ?? safeDiagnosticString(event.d.statusMessage)
      );
    case "otel.log":
      // Log records carry severityText/body (otel-adapter.ts convertOtlpLogsToEvents); name and
      // statusMessage are span-only fields and are undefined here. Source the sig from the log's
      // own fields, still REDACTED via safeDiagnosticString (120-char cap, no raw body).
      return (
        safeDiagnosticString(event.d.severityText) ??
        safeDiagnosticString(event.d.body)
      );
    case "frontend.error":
    case "console.error":
      return safeDiagnosticString(event.d.msg);
    case "backend.error":
      return (
        safeDiagnosticString(event.d.message) ??
        safeDiagnosticString(event.d.code)
      );
    default:
      return undefined;
  }
}

function briefFor(event: BugEvent, kind: CausalNodeKind): string {
  const method = safeString(event.d.m ?? event.d.method);
  switch (kind) {
    case "user.click":
      return "user click";
    case "user.input":
      return "user input";
    case "user.nav":
      return `nav ${safeUrl(event.d.to) ?? ""}`.trim();
    case "net.req":
      return `${method ?? "req"} ${safeUrl(event.d.url) ?? ""}`.trim();
    case "net.res": {
      const st = typeof event.d.st === "number" ? event.d.st : undefined;
      return `res ${st ?? ""} ${safeUrl(event.d.url) ?? ""}`.trim();
    }
    case "backend.req":
      return `backend ${routeFor(event) ?? ""}`.trim();
    case "backend.error":
      return `backend error ${sigFor(event, kind) ?? ""}`.trim();
    case "db.write":
      return `db ${safeString(event.d.op) ?? "write"} ${safeString(event.d.table) ?? ""}`.trim();
    case "otel.span":
      return `span ${safePath(event.d.name) ?? ""}`.trim();
    case "otel.log":
      return `log ${sigFor(event, kind) ?? ""}`.trim();
    case "frontend.error":
      return `frontend error ${sigFor(event, kind) ?? ""}`.trim();
    case "console.error":
      return `console error ${sigFor(event, kind) ?? ""}`.trim();
    default:
      return kind;
  }
}

/**
 * Browser-plane node kinds. These are the only nodes that carry a navigation epoch, because
 * they are the only ones a `user.nav` is meaningfully "between".
 */
const FRONTEND_PLANE_KINDS = new Set<CausalNodeKind>([
  "user.click",
  "user.input",
  "user.nav",
  "net.req",
  "net.res",
  "frontend.error",
  "console.error",
]);

/** Node kinds treated as "network request roots" for interaction back-scan. */
const NET_REQ_KINDS = new Set<CausalNodeKind>(["net.req"]);
const USER_INTERACTION_KINDS = new Set<CausalNodeKind>([
  "user.click",
  "user.input",
]);
const SYMPTOM_TARGET_KINDS = new Set<CausalNodeKind>([
  "frontend.error",
  "console.error",
]);

/**
 * Pure, deterministic. Assembles a CausalGraph from the event stream. No fs/IO, no Date.now, no
 * randomness, no input mutation.
 */
export function buildCausalGraph(input: { events: BugEvent[] }): CausalGraph {
  const { events } = input;

  // --- 1. Build a browser-id -> requestId join for network events (mirrors post-process) --------
  const browserIdToRequestId = new Map<string, string>();
  for (const event of events) {
    if (
      event.k === "net.req" ||
      event.k === "net.res" ||
      event.k === "net.err"
    ) {
      const browserId = safeId(event.d.id);
      const requestId = safeId(event.d.requestId);
      if (browserId && requestId && !browserIdToRequestId.has(browserId)) {
        browserIdToRequestId.set(browserId, requestId);
      }
    }
  }

  // --- 2. Derive nodes (no array-index ids) ----------------------------------------------------
  const derived: DerivedNode[] = [];
  for (const event of events) {
    const kind = nodeKindFor(event);
    if (!kind) continue;

    let requestId = safeId(event.d.requestId);
    if (!requestId && (kind === "net.req" || kind === "net.res")) {
      const browserId = safeId(event.d.id);
      if (browserId) requestId = browserIdToRequestId.get(browserId);
    }

    const disambiguator = disambiguatorFor(event, kind);
    const baseId = `${kind}:${event.t}:${disambiguator}`;

    derived.push({
      id: baseId,
      kind,
      t: event.t,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(sigFor(event, kind) !== undefined
        ? { sig: sigFor(event, kind) }
        : {}),
      ...(routeFor(event) !== undefined ? { route: routeFor(event) } : {}),
      navEpoch: NO_NAV_EPOCH,
      ...(kind === "user.nav" && pagePathOf(event.d.to) !== undefined
        ? { navTo: pagePathOf(event.d.to) }
        : {}),
      brief: briefFor(event, kind),
      srcKind: event.k,
      ...(kind === "net.res" && isFailedNetworkResponse(event)
        ? { failedRes: true }
        : {}),
    });
  }

  // --- 3. Resolve residual id collisions deterministically -------------------------------------
  // Pre-sort by (t, then baseId) -- never iteration order -- so a colliding pair gets a stable
  // counter suffix that is identical across builds regardless of input order.
  const collisionSort = [...derived].sort(
    (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const seen = new Map<string, number>();
  for (const node of collisionSort) {
    const count = seen.get(node.id) ?? 0;
    seen.set(node.id, count + 1);
    if (count > 0) node.id = `${node.id}#${count}`;
  }

  // --- 4. Derive edges -------------------------------------------------------------------------
  const edges: CausalEdge[] = [];
  const edgeSeen = new Set<string>();
  // Track which "effect" nodes already have a stronger (non-temporal) edge keyed to them, so the
  // temporal fallback (rule 4) never double-emits.
  const strongerEdgeTargets = new Set<string>();

  function addEdge(
    from: string,
    to: string,
    kind: CausalEdgeKind,
    conf: CausalConfidence,
  ): void {
    if (from === to) return;
    const key = JSON.stringify([from, to, kind]);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind, confidence: conf });
    if (kind !== "temporal") strongerEdgeTargets.add(to);
  }

  const byTime = [...derived].sort(
    (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // --- 3b. Assign navigation epochs -------------------------------------------------------------
  // Walk the browser plane in time order. Every `user.nav` opens a new epoch and belongs to the
  // epoch it opened, so two nodes sharing an epoch are guaranteed to have no navigation between
  // them. Epoch 0 covers anything captured before the first nav commits; the interaction
  // collector emits an `init` nav when it starts, so in a real session that window is empty.
  // `pageRoute` is the label on the epoch and may be absent (a nav whose destination did not
  // survive redaction) without affecting the comparison, which is on the epoch itself.
  {
    let epoch = 0;
    let pageRoute: string | undefined;
    for (const node of byTime) {
      if (!FRONTEND_PLANE_KINDS.has(node.kind)) continue;
      if (node.kind === "user.nav") {
        epoch += 1;
        pageRoute = node.navTo;
      }
      node.navEpoch = epoch;
      if (pageRoute !== undefined) node.pageRoute = pageRoute;
    }
  }

  // Rule 1 -- request (high): per requestId, order that request's nodes by t and connect the spine.
  const byRequestId = new Map<string, DerivedNode[]>();
  for (const node of byTime) {
    if (!node.requestId) continue;
    const list = byRequestId.get(node.requestId) ?? [];
    list.push(node);
    byRequestId.set(node.requestId, list);
  }
  for (const [, group] of byRequestId) {
    // group is already t-sorted (byTime is sorted). Connect the HTTP spine in canonical order.
    connectRequestSpine(group, addEdge);
  }
  // OTLP: net.req ->(traceId===requestId) otel.span -> otel.log is handled inside connectRequestSpine
  // since span/log share the same requestId (=traceId) as the network node.

  // Rule 2 -- interaction: backward-scan from a net.req node to the nearest preceding
  // user.click/user.input within WINDOW_MS.
  for (let i = 0; i < byTime.length; i++) {
    const node = byTime[i];
    if (!NET_REQ_KINDS.has(node.kind)) continue;
    const trigger = scanBackward(byTime, i, USER_INTERACTION_KINDS);
    if (!trigger) continue;
    const delta = node.t - trigger.t;
    // Same navigation epoch: no page transition happened between the interaction and the
    // request. The case this downgrades is the real false positive — a click that navigates,
    // followed inside the 2s window by the next page's boot requests, which the click did not
    // cause. Comparing routes or sigs here cannot work: no browser collector emits `route`, and
    // an interaction node has no `sig`, so both sides were always undefined and this band was
    // unreachable.
    const sameContext = node.navEpoch === trigger.navEpoch;
    const conf: CausalConfidence =
      delta <= HIGH_CONFIDENCE_MS && sameContext ? "high" : "medium";
    addEdge(trigger.id, node.id, "interaction", conf);
  }

  // Rule 3 -- symptom: from a failed net.res or backend.error node to a FOLLOWING
  // frontend.error/console.error within WINDOW_MS.
  for (let i = 0; i < byTime.length; i++) {
    const source = byTime[i];
    const isFailedRes = source.kind === "net.res" && source.failedRes === true;
    const isBackendError = source.kind === "backend.error";
    if (!isFailedRes && !isBackendError) continue;
    // forward scan for the nearest following symptom within window
    for (let j = i + 1; j < byTime.length; j++) {
      const target = byTime[j];
      if (target.t - source.t > WINDOW_MS) break;
      if (!SYMPTOM_TARGET_KINDS.has(target.kind)) continue;
      const conf = confidence2(target.t - source.t);
      addEdge(source.id, target.id, "symptom", conf);
      break; // nearest following only
    }
  }

  // Rule 4 -- temporal (low): from an err/rej/con(error) node to the nearest preceding trigger
  // within WINDOW_MS, ONLY when no stronger edge already keys that node.
  const TEMPORAL_TRIGGER_KINDS = new Set<CausalNodeKind>([
    "user.click",
    "user.input",
    "user.nav",
    "net.res",
    "net.req",
  ]);
  for (let i = 0; i < byTime.length; i++) {
    const node = byTime[i];
    if (!SYMPTOM_TARGET_KINDS.has(node.kind)) continue;
    if (strongerEdgeTargets.has(node.id)) continue; // stronger edge already covers it
    const trigger = scanBackward(byTime, i, TEMPORAL_TRIGGER_KINDS);
    if (!trigger) continue;
    addEdge(trigger.id, node.id, "temporal", "low");
  }

  // --- 5. Sort for byte-identical output -------------------------------------------------------
  const nodes: CausalNode[] = derived
    .map(stripDerived)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  edges.sort((a, b) =>
    a.from < b.from
      ? -1
      : a.from > b.from
        ? 1
        : a.to < b.to
          ? -1
          : a.to > b.to
            ? 1
            : a.kind < b.kind
              ? -1
              : a.kind > b.kind
                ? 1
                : 0,
  );

  // Only the aliases that actually differ from the id they map to are worth carrying: an entry
  // where both sides are equal is a no-op at lookup time and pure payload in the bundle.
  const requestIdAliases: Record<string, string> = {};
  for (const [browserId, requestId] of browserIdToRequestId) {
    if (browserId !== requestId) requestIdAliases[browserId] = requestId;
  }

  return {
    schemaVersion: CAUSAL_GRAPH_SCHEMA_VERSION,
    nodes,
    edges,
    ...(Object.keys(requestIdAliases).length > 0 ? { requestIdAliases } : {}),
  };
}

function stripDerived(node: DerivedNode): CausalNode {
  const {
    srcKind: _srcKind,
    failedRes: _failedRes,
    navEpoch: _navEpoch,
    navTo: _navTo,
    ...rest
  } = node;
  return rest;
}

// --- Candidate -> node attribution (CP3) -------------------------------------------------------
// Pure, deterministic, no IO, no input mutation. Maps evidence candidates onto graph nodes, then
// classifies each candidate as a root cause, a downstream symptom, or isolated by walking the
// causal ancestry. The caller (evidence-index ranker) uses this to demote symptoms below their
// root while keeping the emitted candidate set unchanged.
//
// The input graph is treated as READ-ONLY: candidateId association lives entirely in local side
// maps here and never mutates `graph.nodes`.

/** Temporal window (ms) for the fallback candidate->node mapping (step 2 of the precedence). */
export const CAUSAL_MAP_WINDOW_MS = 2000;

export type CausalRole = "root" | "symptom" | "isolated";

export interface CandidateAttribution {
  causalRole: CausalRole;
  rootCauseId?: string;
  causes?: string[];
  attributionConfidence?: CausalConfidence;
}

export interface AttributableCandidate {
  id: string;
  anchor: { t: number; requestId?: string; route?: string };
}

/**
 * Detectors whose subject is a single database write: `db_mutation` surfaces
 * the write plane, `db_field_divergence`, `duplicate_write` and
 * `db_client_supplied_value` name a specific failure in one of those writes.
 * All of them anchor on the write itself, so they share a node family and can
 * contend for the same node.
 *
 * `db_client_supplied_value` anchors on the `db.diff` of the write that stored
 * the client's number, which is the same event `db_mutation` anchors on. Left
 * out of this table it reached a node only through the requestId match, took
 * the empty kind family in {@link nodeKindsForDetector} whenever that missed,
 * and — because {@link isDbWriteEnd} reads this set — presented as something
 * other than a write, which re-inflated the confidence of every write-to-write
 * claim running through it.
 *
 * `db_delta_mismatch` is deliberately absent: it is a named DB invariant, but it
 * has never been in this table, and adding it here would change which node the
 * temporal fallback hands it. That is a behavior change, not a comment fix, so
 * it is left alone.
 */
const DB_WRITE_DETECTORS = new Set([
  "db_mutation",
  "db_field_divergence",
  "duplicate_write",
  "db_client_supplied_value",
  "db_unrequested_clear",
  "response_count_mismatch",
  "retry_loop_against_success",
  "db_write_read_column_split",
]);

/**
 * Maps a candidate detector family onto the node kinds it can attribute to. Deterministic; used
 * only by the temporal fallback (precedence step 2) when a candidate has no requestId match.
 */
function nodeKindsForDetector(detector: string): Set<CausalNodeKind> {
  if (detector.startsWith("backend_"))
    return new Set(["backend.error", "backend.req"]);
  // db_field_divergence and duplicate_write read the same plane as db_mutation.
  // Each anchors on a write it names explicitly, so when the requestId match in
  // precedence step 1 does not apply they should still reach a db.write node
  // rather than falling through to isolated.
  if (DB_WRITE_DETECTORS.has(detector)) return new Set(["db.write"]);
  switch (detector) {
    case "http_error":
    case "app_2xx_failure":
    case "network_error":
    case "slow_request":
    case "pending_request":
      return new Set(["net.res", "net.req"]);
    case "uncaught_error":
    case "unhandled_rejection":
      return new Set(["frontend.error"]);
    // A detector whose whole subject is one click has to be able to reach that click's node.
    // Without an entry here it took the empty default, the temporal fallback had no compatible
    // kind, and it reported `isolated` — which drops it out of the incident thread and leaves
    // `causal_chain` null even though the graph already carries interaction edges from the click
    // to whatever did or did not follow it.
    case "click_target_intercepted":
      return new Set(["user.click"]);
    // Without this the finding is always isolated - the same failure documented above for
    // click_target_intercepted, and the reason a job that never ran would drop out of the incident
    // thread it belongs to.
    case "job_did_not_complete":
      return new Set(["backend.error", "backend.req"]);
    // The finding IS the disagreement between a response and what was drawn from it, so the response
    // is the node it belongs on. Without an entry here it reports `isolated` and drops out of the
    // incident thread - the same failure already paid for by click_target_intercepted.
    case "stale_value_rendered":
    case "displayed_field_mismatch":
      return new Set(["net.res", "net.req"]);
    case "console_error":
      return new Set(["console.error"]);
    // console_warning is intentionally NOT mapped: warn-level `con` events never become graph nodes
    // (nodeKindFor only emits console.error for error-level), so a warning has no node of its own.
    // Falling through to the empty default keeps it isolated instead of stealing a real
    // console.error node from a genuine console_error candidate.
    default:
      if (detector.startsWith("otel_"))
        return new Set(["otel.span", "otel.log"]);
      return new Set();
  }
}

/**
 * Detectors that NAME a specific failure on a plane another detector merely
 * surfaces, and that must therefore own a contended node ahead of that generic
 * twin. Each entry has a twin it can tie with on the same event:
 * `db_delta_mismatch`, `db_field_divergence`, `duplicate_write` and
 * `db_client_supplied_value` against `db_mutation`; `otel_span_error` against
 * `otel_db_activity`, which fires on the same span when a database span carries
 * ERROR status.
 *
 * `db_client_supplied_value` ALWAYS ties with `db_mutation` — both anchor on the
 * same `db.diff` — so before it was listed here, the node that decides which of
 * the two becomes the causal root was awarded by dedupe-key alphabet
 * (`dbclientvalue:` sorting under `dbdiff:`). The right answer was reached by
 * the wrong rule, and renaming either key would have silently reversed it.
 *
 * This is an ALLOWLIST, and omission is the safe answer, not an oversight. A
 * detector left out takes the default in {@link ownershipPriority}, which is no
 * ownership claim at all: contention involving it falls through to the id
 * tie-break it used before this rule existed. Listing a detector is what changes
 * behavior, so a new generic plane detector cannot quietly acquire priority over
 * the named detectors it ties with — the same default-safe shape as
 * {@link nodeKindsForDetector}, which falls an unknown detector to the empty set
 * (isolated) rather than to a node it might not own.
 */
const NAMED_FAILURE_DETECTORS = new Set([
  "db_delta_mismatch",
  "db_field_divergence",
  "duplicate_write",
  "db_client_supplied_value",
  "db_unrequested_clear",
  "response_count_mismatch",
  "retry_loop_against_success",
  "db_write_read_column_split",
  "otel_span_error",
]);

/**
 * The generic twins from that list: detectors that surface a plane without
 * naming anything wrong on it. `db_mutation` says "a write happened";
 * `otel_db_activity` says "a database span exists".
 *
 * Same ALLOWLIST discipline as {@link NAMED_FAILURE_DETECTORS}, and the same
 * default: a detector left out is not treated as generic, so an unlisted
 * detector never loses a position it would otherwise hold.
 */
const GENERIC_PLANE_DETECTORS = new Set(["db_mutation", "otel_db_activity"]);

/**
 * Does `symptomDetector` name a failure on a plane `rootDetector` merely
 * surfaces?
 *
 * The ranker uses this to answer one question: may this root be lifted ahead of
 * this symptom? "A write happened on products" must never be ranked above the
 * invariant violation that says what is wrong, so for that pair the answer is
 * no. It is the same principle {@link ownershipPriority} applies to node
 * contention — a reader asking "what is wrong here" is answered by the named
 * invariant violation, never by "a write happened" — carried over to the one
 * ordering rule that could otherwise reimpose the opposite.
 */
export function namesFailureOnGenericPlane(
  rootDetector: string | undefined,
  symptomDetector: string | undefined,
): boolean {
  if (rootDetector === undefined || symptomDetector === undefined) return false;
  return (
    GENERIC_PLANE_DETECTORS.has(rootDetector) &&
    NAMED_FAILURE_DETECTORS.has(symptomDetector)
  );
}

/**
 * Ordering key for node ownership, applied ONLY to candidates that tie on
 * `anchor.t`. Two candidates can describe the SAME event — `db_mutation` says "a
 * write happened on order_items", `db_field_divergence` says "that write
 * disagrees with the products row it references". They anchor on the same
 * timestamp and the same request, so they contend for one node, and the winner
 * becomes the causal root while the loser is pushed down as a symptom of it.
 *
 * Resolving that by candidate id would decide it on a dedupe key prefix, which
 * is an accident of naming. Resolve it by what the candidate says instead: the
 * candidate that names the failure owns the node, and the generic surfacing of
 * the same event falls back to another write or to isolated. A reader asking
 * "what is wrong here" is answered by the named invariant violation, never by
 * "a write happened".
 *
 * Scope, precisely: this is the THIRD sort key, under `anchor.t`. It arbitrates
 * a tie at equal anchor time and nothing else — an earlier generic candidate
 * still reaches a shared node before a later named one. That is sufficient here
 * only because a named DB invariant anchors on the earliest event of the pair it
 * compares, which is the same event `db_mutation` anchors on. A detector that
 * anchored on the later event would still lose the node, and this key would not
 * save it.
 *
 * Named versus named is not resolved: every listed detector returns 0, so two of
 * them tying at the same anchor time still fall through to the id tie-break. No
 * captured session reaches that case, and inventing an order between two named
 * failures would be guessing.
 *
 * Lower sorts first, so 0 is the named failure and 1 the default.
 */
function ownershipPriority(detector: string | undefined): number {
  return detector !== undefined && NAMED_FAILURE_DETECTORS.has(detector)
    ? 0
    : 1;
}

const CONFIDENCE_RANK: Record<CausalConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Returns the weaker of two confidences (min over high>medium>low). */
function weakerConfidence(
  a: CausalConfidence,
  b: CausalConfidence,
): CausalConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Pure, deterministic candidate->node attribution over a prebuilt CausalGraph.
 *
 * Mapping precedence (anchor -> at most one node):
 *   1. requestId match: nearest |delta-t|, then a node kind the detector describes, then node id asc.
 *   2. temporal + compatible-kind fallback within CAUSAL_MAP_WINDOW_MS: nearest t, tie-break id asc.
 *      A DB write detector is additionally barred from any `db.write` node but its own, so a
 *      displaced write reports isolated rather than a neighbour's write.
 *   3. no match -> isolated.
 * One candidate per node: on contention the smaller anchor.t wins, then the candidate that NAMES a
 * failure over the generic surfacing of the same event (see {@link ownershipPriority}), then the
 * smaller candidate id; the loser falls back to (2)/(3).
 *
 * Classification (over reverse adjacency effect->cause): nearest candidate-bearing ancestor = root;
 * this candidate becomes a symptom whose rootCauseId is that ancestor and whose attributionConfidence
 * is the WEAKEST edge confidence along the path, then clamped to `low` when both ends of the claim
 * are database writes (spine order is not causation — see {@link clampWriteToWriteClaim}). A
 * candidate node with no candidate-bearing ancestor is a root, and its `causes` are the sorted
 * candidate ids of the symptoms attributed to it.
 */
export function attributeCandidates(
  graph: CausalGraph,
  candidates: AttributableCandidate[],
  /**
   * Optional detector lookup (candidate id -> detector). When provided, the temporal fallback
   * (mapping precedence step 2) restricts to node kinds compatible with the candidate's detector
   * family; when omitted, step 2 falls back to any unowned node in the window. Pure/deterministic
   * either way. The evidence-index ranker always supplies this.
   */
  detectorById?: (id: string) => string | undefined,
): Map<string, CandidateAttribution> {
  if (graph.nodes.length === 0 || candidates.length === 0) {
    const empty = new Map<string, CandidateAttribution>();
    for (const c of candidates) empty.set(c.id, { causalRole: "isolated" });
    return empty;
  }
  return attributeCandidatesInternal(
    graph,
    candidates,
    detectorById ?? (() => undefined),
  );
}

function attributeCandidatesInternal(
  graph: CausalGraph,
  candidates: AttributableCandidate[],
  detectorById: (id: string) => string | undefined,
): Map<string, CandidateAttribution> {
  // --- 1. Map each candidate to at most one node (with per-node contention arbitration) --------
  // Process candidates in a deterministic order (anchor.t asc, then ownership priority, then id
  // asc) so contention winners are stable regardless of input order. Since the incumbent always
  // wins contention, processing order IS the arbitration rule: see ownershipPriority for why a
  // named failure must reach a shared node before the generic plane surfacing of the same event.
  const sortedCandidates = [...candidates].sort(
    (a, b) =>
      a.anchor.t - b.anchor.t ||
      ownershipPriority(detectorById(a.id)) -
        ownershipPriority(detectorById(b.id)) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // node id -> candidate id currently owning it.
  const nodeToCandidate = new Map<string, string>();
  // candidate id -> node id it maps to (undefined until resolved / isolated).
  const candidateToNode = new Map<string, string | undefined>();

  const nodes = graph.nodes;

  function findRequestIdNode(
    candidateId: string,
    anchor: AttributableCandidate["anchor"],
  ): CausalNode | undefined {
    if (!anchor.requestId) return undefined;
    // Resolve a browser-local id onto the correlated one before matching. See
    // `CausalGraph.requestIdAliases` for why an anchor and a node can name the same request with
    // two different ids, and what it costs when they fail to meet.
    const wanted = graph.requestIdAliases?.[anchor.requestId] ?? anchor.requestId;
    const matches = nodes.filter((n) => n.requestId === wanted);
    if (matches.length === 0) return undefined;
    // Kind compatibility, used ONLY to break a tie at equal |delta-t|. A request routinely closes on
    // the same millisecond as its last write, and `backend.req` sorts under `db.write` by id, so the
    // write was handed the node for the request's end instead of the node for itself. That is an
    // accident of two node ids and a shared millisecond, not a statement about the candidate.
    //
    // Time still dominates: a nearer node of the wrong kind still wins, so this cannot pull a
    // candidate onto a distant node just because the kind matches. An unknown detector takes the
    // empty family and every node ties at 1, leaving its order exactly as it was.
    const detector = detectorById(candidateId);
    const kinds =
      detector !== undefined ? nodeKindsForDetector(detector) : undefined;
    const kindRank = (node: CausalNode): number =>
      kinds !== undefined && kinds.has(node.kind) ? 0 : 1;
    return [...matches].sort((a, b) => {
      const da = Math.abs(a.t - anchor.t);
      const db = Math.abs(b.t - anchor.t);
      if (da !== db) return da - db;
      const ka = kindRank(a);
      const kb = kindRank(b);
      if (ka !== kb) return ka - kb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
  }

  function findTemporalNode(
    candidateId: string,
    anchor: AttributableCandidate["anchor"],
    excluded: Set<string>,
  ): CausalNode | undefined {
    const detector = detectorById(candidateId);
    // When a detector is known, restrict to its compatible node-kind family. A KNOWN detector with
    // NO causal node family (e.g. page_probe_failure, media_degradation, tab_boundary_gap,
    // user_marker, repeated_clicks) must NOT temporal-match arbitrary nodes -- it stays isolated so it
    // never steals a request-spine node from the candidate that actually belongs to it. Only when no
    // detector is supplied at all (detectorById -> undefined) do we allow an unrestricted match.
    const kinds =
      detector !== undefined ? nodeKindsForDetector(detector) : undefined;
    if (kinds !== undefined && kinds.size === 0) return undefined;
    // A DB write detector names ONE write. The nearest unowned `db.write` node is some OTHER write
    // of the same request, and handing it that node makes the candidate report a write it does not
    // describe. Worse, it cascades: when a named failure takes the node for the write they share,
    // the displaced `db_mutation` lands on the next write, displacing THAT one in turn, until the
    // emitted chain is write order shifted by a slot — which is how a candidate came to name a
    // write that happened after it as its own cause. Its own node is `db.write` at the same
    // instant in the same request; anything else is not it, so it stays isolated instead.
    const ownWriteOnly =
      detector !== undefined && DB_WRITE_DETECTORS.has(detector);
    const matches = nodes.filter((n) => {
      if (excluded.has(n.id)) return false;
      if (Math.abs(n.t - anchor.t) > CAUSAL_MAP_WINDOW_MS) return false;
      if (kinds && !kinds.has(n.kind)) return false;
      if (ownWriteOnly && n.kind === "db.write" && n.t !== anchor.t)
        return false;
      return true;
    });
    if (matches.length === 0) return undefined;
    return [...matches].sort((a, b) => {
      const da = Math.abs(a.t - anchor.t);
      const db = Math.abs(b.t - anchor.t);
      if (da !== db) return da - db;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
  }

  // Resolve one candidate to a node, arbitrating contention. Returns the node id or undefined.
  function resolve(candidate: AttributableCandidate): string | undefined {
    const excluded = new Set<string>(nodeToCandidate.keys());

    // Precedence 1: requestId match (may already be owned -> arbitrate).
    const reqNode = findRequestIdNode(candidate.id, candidate.anchor);
    if (reqNode) {
      const owner = nodeToCandidate.get(reqNode.id);
      if (owner === undefined) {
        nodeToCandidate.set(reqNode.id, candidate.id);
        return reqNode.id;
      }
      // Contention: smaller anchor.t, then the named failure over the generic plane surfacing of
      // the same event, then smaller id. Since sortedCandidates is processed in that order, the
      // incumbent always wins requestId contention; the loser falls through.
    }

    // Precedence 2: temporal + compatible-kind fallback over still-unowned nodes.
    const tempNode = findTemporalNode(candidate.id, candidate.anchor, excluded);
    if (tempNode) {
      nodeToCandidate.set(tempNode.id, candidate.id);
      return tempNode.id;
    }

    // Precedence 3: isolated.
    return undefined;
  }

  for (const candidate of sortedCandidates) {
    const nodeId = resolve(candidate);
    candidateToNode.set(candidate.id, nodeId);
  }

  // --- 2. Reverse adjacency (effect -> causes) --------------------------------------------------
  const causesByEffect = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = causesByEffect.get(edge.to) ?? [];
    list.push(edge.from);
    causesByEffect.set(edge.to, list);
  }
  const confByPair = new Map<string, CausalConfidence>();
  for (const edge of graph.edges) {
    // For a given (effect,cause) pair keep the STRONGEST edge confidence (best available link);
    // path weakness is then the min across the path's per-hop best links. Deterministic.
    const key = JSON.stringify([edge.to, edge.from]);
    const existing = confByPair.get(key);
    if (
      existing === undefined ||
      CONFIDENCE_RANK[edge.confidence] > CONFIDENCE_RANK[existing]
    ) {
      confByPair.set(key, edge.confidence);
    }
  }

  const kindById = new Map<string, CausalNodeKind>(
    nodes.map((node) => [node.id, node.kind]),
  );

  /**
   * Is this end of a hop a database write?
   *
   * Two ways to be one, and both are needed. The node kind is the direct
   * answer: a `db.write` node was built from a `db.diff` event. The owning
   * candidate is the answer when the node kind does not say so — precedence 1
   * of the mapping takes the node NEAREST in time, so a write whose
   * `backend.req` node is closer than its own `db.write` node is attributed
   * there. The candidate still describes a write; only the node it landed on
   * does not. Reading the kind alone would clamp the writes of one request and
   * leave that one at high confidence purely on the accident of which node was
   * nearest.
   *
   * The common case — a request closing on its last write's millisecond — is no
   * longer one of these: an equal-distance tie now prefers a node kind the
   * detector describes. What remains is the genuinely nearer non-write node,
   * which no tie-break can address, so this stays as the backstop for it.
   */
  function isDbWriteEnd(nodeId: string): boolean {
    if (kindById.get(nodeId) === "db.write") return true;
    const candidateId = nodeToCandidate.get(nodeId);
    if (candidateId === undefined) return false;
    const detector = detectorById(candidateId);
    return detector !== undefined && DB_WRITE_DETECTORS.has(detector);
  }

  /**
   * How strongly one hop of the request spine supports a CAUSAL claim.
   *
   * The spine chains a request's nodes in time order, so consecutive writes in
   * one request are joined by a high confidence `request` edge. That edge is a
   * true statement about ordering and a weak one about causation: which write
   * an application performs after which is a free choice of the code, and says
   * nothing about which write is at fault. Reading it as high confidence
   * causation makes every write the established cause of the next one, so the
   * write a detector actually named is ranked behind every write that happened
   * to precede it.
   *
   * The edge stays as captured — the two writes really are consecutive stages
   * of one request. Only the causal claim drawn through it is weakened, to the
   * same `low` tier the ranker treats as annotate only.
   *
   * Scope: this weakens EVERY write-to-write hop, not only spine hops, because
   * `confByPair` keeps a confidence per (effect, cause) pair and discards
   * `edge.kind`. The spine is the only rule that joins two db.write nodes
   * today, so the two are the same set. Should a later rule draw a genuinely
   * causal write-to-write edge, it would be clamped here as well and the
   * predicate would have to read `edge.kind` to tell them apart.
   *
   * A hop is not the whole claim, though: two writes of one request are
   * ADJACENT on the spine only when nothing else of that request happened
   * between them. Let one OTLP span land in between and the path becomes
   * write -> span -> write, neither hop is write-to-write, and the same
   * ordering-not-causation claim comes back out graded `high`. See
   * {@link clampWriteToWriteClaim}, which re-applies the rule to the claim's
   * two ends after the walk, where the intervening nodes cannot launder it.
   */
  function hopConfidence(effectId: string, causeId: string): CausalConfidence {
    if (isDbWriteEnd(effectId) && isDbWriteEnd(causeId)) return "low";
    return confByPair.get(JSON.stringify([effectId, causeId])) ?? "low";
  }

  /**
   * The write-to-write rule applied to the CLAIM rather than to a hop: whatever
   * the walk passed through, "one write of a request caused another write of
   * the same request" is a statement about the order the handler chose, so it
   * cannot be graded above `low`.
   *
   * This is what the per-hop clamp cannot see. In the checkout that motivated
   * it, an OTLP span was emitted between the inventory decrement and the order
   * insert, so the path ran write -> span -> write, both hops graded `high`,
   * and the client-supplied-total finding was published as an established
   * effect of an unrelated stock update.
   *
   * Only the grade moves; the link itself is still emitted, so a reader can
   * still follow the sequence.
   */
  function clampWriteToWriteClaim(
    startNodeId: string,
    rootNodeId: string,
    conf: CausalConfidence,
  ): CausalConfidence {
    if (isDbWriteEnd(startNodeId) && isDbWriteEnd(rootNodeId))
      return weakerConfidence(conf, "low");
    return conf;
  }

  // --- 3. For each mapped candidate, walk ancestors to the nearest candidate-bearing ancestor ---
  // Returns { rootNodeId, weakestConfidence } or undefined when no candidate-bearing ancestor.
  function nearestCandidateAncestor(
    startNodeId: string,
  ): { rootNodeId: string; conf: CausalConfidence } | undefined {
    // BFS over reverse adjacency, tracking the weakest confidence along each path. Deterministic
    // frontier ordering (sorted) + visited guard against cycles. First candidate-bearing ancestor
    // reached (by fewest hops, tie-broken by node id) wins.
    const visited = new Set<string>([startNodeId]);
    // frontier entries: [nodeId, weakestConfAlongPath]
    let frontier: Array<[string, CausalConfidence | undefined]> = [
      [startNodeId, undefined],
    ];
    while (frontier.length > 0) {
      const next: Array<[string, CausalConfidence | undefined]> = [];
      // Expand this hop-level, collecting candidate-bearing hits deterministically.
      const hits: Array<{ rootNodeId: string; conf: CausalConfidence }> = [];
      for (const [nodeId, pathConf] of frontier) {
        const causes = [...(causesByEffect.get(nodeId) ?? [])].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const causeId of causes) {
          if (visited.has(causeId)) continue;
          visited.add(causeId);
          const hopConf = hopConfidence(nodeId, causeId);
          const newPathConf =
            pathConf === undefined
              ? hopConf
              : weakerConfidence(pathConf, hopConf);
          if (nodeToCandidate.has(causeId)) {
            hits.push({ rootNodeId: causeId, conf: newPathConf });
          } else {
            next.push([causeId, newPathConf]);
          }
        }
      }
      if (hits.length > 0) {
        hits.sort((a, b) =>
          a.rootNodeId < b.rootNodeId
            ? -1
            : a.rootNodeId > b.rootNodeId
              ? 1
              : 0,
        );
        return hits[0];
      }
      frontier = next;
    }
    return undefined;
  }

  const attribution = new Map<string, CandidateAttribution>();
  // symptoms grouped by root candidate id, for the root's `causes` list.
  const symptomsByRoot = new Map<string, string[]>();

  for (const candidate of candidates) {
    const nodeId = candidateToNode.get(candidate.id);
    if (nodeId === undefined) {
      attribution.set(candidate.id, { causalRole: "isolated" });
      continue;
    }
    const ancestor = nearestCandidateAncestor(nodeId);
    if (ancestor) {
      const rootCandidateId = nodeToCandidate.get(ancestor.rootNodeId)!;
      attribution.set(candidate.id, {
        causalRole: "symptom",
        rootCauseId: rootCandidateId,
        attributionConfidence: clampWriteToWriteClaim(
          nodeId,
          ancestor.rootNodeId,
          ancestor.conf,
        ),
      });
      const list = symptomsByRoot.get(rootCandidateId) ?? [];
      list.push(candidate.id);
      symptomsByRoot.set(rootCandidateId, list);
    } else {
      // Provisional root; `causes` filled in below once all symptoms are known.
      attribution.set(candidate.id, { causalRole: "root" });
    }
  }

  // Fill each root's sorted `causes` list (omit when empty so undefined never serializes).
  for (const [rootId, attr] of attribution) {
    if (attr.causalRole !== "root") continue;
    const symptoms = symptomsByRoot.get(rootId);
    if (symptoms && symptoms.length > 0) {
      attr.causes = [...symptoms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
  }

  return attribution;
}

/**
 * Backward-scan: break when effectTime - n.t exceeds WINDOW_MS, return the first (nearest)
 * preceding node whose kind matches. Operates over derived nodes sorted by time.
 */
function scanBackward(
  nodes: DerivedNode[],
  effectIdx: number,
  kinds: Set<CausalNodeKind>,
): DerivedNode | undefined {
  const effectTime = nodes[effectIdx].t;
  for (let i = effectIdx - 1; i >= 0; i--) {
    const n = nodes[i];
    if (effectTime - n.t > WINDOW_MS) break;
    if (kinds.has(n.kind)) return n;
  }
  return undefined;
}

/**
 * Connects the request spine (high confidence) for one requestId's time-ordered nodes:
 *   net.req -> backend.req(start) -> db.write* -> (backend.error | backend.req(end)) -> net.res
 * OTLP variant (same requestId===traceId):
 *   net.req -> otel.span -> otel.log
 * Emits sequential edges between the canonical stages present, in time order.
 */
function connectRequestSpine(
  group: DerivedNode[],
  addEdge: (
    from: string,
    to: string,
    kind: CausalEdgeKind,
    conf: CausalConfidence,
  ) => void,
): void {
  // Canonical stage ranking within a request. Lower rank precedes higher rank; equal-rank nodes
  // (e.g. multiple db.write) are chained in time order.
  const rankOf = (kind: CausalNodeKind): number => {
    switch (kind) {
      case "net.req":
        return 0;
      case "backend.req":
        return 1;
      case "otel.span":
        return 1;
      case "db.write":
        return 2;
      case "otel.log":
        return 2;
      case "backend.error":
        return 3;
      case "net.res":
        return 4;
      default:
        return -1;
    }
  };

  // Primary order is time (per spec: "order that request's nodes by t"); the canonical stage rank
  // is only a deterministic tiebreak for events that share a timestamp.
  const spine = group
    .filter((n) => rankOf(n.kind) >= 0)
    .sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      const ra = rankOf(a.kind);
      const rb = rankOf(b.kind);
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  for (let i = 0; i + 1 < spine.length; i++) {
    addEdge(spine[i].id, spine[i + 1].id, "request", "high");
  }
}
