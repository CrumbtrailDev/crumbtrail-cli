import type { SessionStore } from "./session-store";

export const CRUMBTRAIL_SCHEMA_VERSION = 1 as const;

export const CRUMBTRAIL_EVENT_KINDS = {
  navigation: "navigation",
  appLifecycle: "app-lifecycle",
  nativeCrash: "native-crash",
  viewSnapshot: "view-snapshot",
} as const;

export type CrumbtrailPlatform =
  "web" | "react-native" | "ios" | "android" | "flutter" | "webview" | "node";

export interface CrumbtrailSdkDescriptor {
  name: string;
  version?: string;
}

export type CrumbtrailCapabilities = string[];

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

type TargetDescriptorIdentityKey =
  | "role"
  | "label"
  | "testID"
  | "accessibilityId"
  | "componentName"
  | "routePath"
  | "ancestryHash";

interface TargetDescriptorBase {
  /** Semantic role of the target, e.g. button, link, textbox, screen, view. */
  role?: string;
  /** Human-readable label visible to or announced for the user. */
  label?: string;
  /** Stable test identifier supplied by the app. */
  testID?: string;
  /** Stable accessibility/native identifier supplied by the app. */
  accessibilityId?: string;
  /** Framework component or native view name. */
  componentName?: string;
  /** App route or screen path where the target appears. */
  routePath?: string;
  /** Privacy-safe hash of the target's ancestor path. */
  ancestryHash?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  redaction?: unknown;
  /** @deprecated Use testID. Accepted while legacy web/mobile emitters migrate. */
  testId?: string;
  /** @deprecated Use accessibilityId or label. Accepted while legacy emitters migrate. */
  accessibilityLabel?: string;
  /** @deprecated Use label. Accepted while legacy web emitters migrate. */
  text?: string;
  /** @deprecated Use componentName. Accepted while legacy emitters migrate. */
  viewName?: string;
  /** @deprecated Use routePath. Accepted while legacy emitters migrate. */
  screen?: string;
  /** @deprecated Accepted while legacy web emitters migrate. */
  selector?: string;
}

export type TargetDescriptor = RequireAtLeastOne<
  TargetDescriptorBase,
  TargetDescriptorIdentityKey
>;

export interface BugEvent {
  /** Unix timestamp in milliseconds */
  t: number;
  /** Event category short code */
  k: string;
  /** Type-specific payload */
  d: Record<string, unknown>;
  /** Version of the shared event envelope. Missing means v1 for backward compatibility. */
  schemaVersion?: typeof CRUMBTRAIL_SCHEMA_VERSION;
  /** Source runtime. Missing means `web` for backward compatibility with current browser SDKs. */
  platform?: CrumbtrailPlatform;
  /** SDK identity for non-browser and future SDKs. */
  sdk?: CrumbtrailSdkDescriptor;
  /** Optional capability names enabled by the emitting SDK/session. */
  capabilities?: CrumbtrailCapabilities;
  /** Optional normalized target reference for web/mobile events. */
  target?: TargetDescriptor;
  /** Active recording session identifier when an extension workflow session owns the event. */
  sessionId?: string;
  /** Milliseconds elapsed from the active recording session's canonical startedAt timestamp. */
  offsetMs?: number;
}

export interface BugReport {
  bugId: string;
  sessionId: string;
  flaggedAt: number;
  windowMs: number;
  note?: string;
  voiceNote?: string;
  url: string;
  userAgent: string;
  /** Pseudonymous identifiers supplied with `identify`; email shaped values are never retained. */
  accountId?: string;
  userId?: string;
  tags?: string[];
  summary: {
    errorCount: number;
    failedRequestCount: number;
    eventCount: number;
    eventKinds: Record<string, number>;
    durationMs: number;
    stateProviderCount?: number;
  };
}

/** Canonical event kind for a database row diff (`k:'db.diff'`). */
export const DB_DIFF_EVENT_KIND = "db.diff" as const;

/**
 * Canonical event kind for an aggregate capped database diff summary (`k:'db.diff.bulk'`).
 * The comparator intentionally ignores this kind: over-cap statements are treated as batch work,
 * while per-row `db.diff` events remain the UI-flow comparison signal.
 */
export const DB_DIFF_BULK_EVENT_KIND = "db.diff.bulk" as const;

/** Canonical event kind for a capped database read row (`k:'db.read'`). */
export const DB_READ_EVENT_KIND = "db.read" as const;

/** Canonical event kind for an aggregate capped database read summary (`k:'db.read.bulk'`). */
export const DB_READ_BULK_EVENT_KIND = "db.read.bulk" as const;

/**
 * Canonical event kind for a database statement that was ATTEMPTED and RAISED (`k:'db.error'`).
 *
 * Deliberately NOT a `capture_gap`. A capture gap says *our instrumentation* could not collect
 * something; this says *the application's statement failed*. Those are two different facts with
 * two different owners, and collapsing them tells a reader the tooling broke when in truth the
 * write blew up. Without this kind the capture vocabulary can only describe statements that
 * succeeded, so the decisive observable in a "the request 500ed because the statement raised"
 * incident is absent from the bundle and the reader has to infer it.
 */
export const DB_ERROR_EVENT_KIND = "db.error" as const;

/**
 * Canonical event kind for a database statement that was ATTEMPTED and SUCCEEDED (`k:'db.statement'`).
 *
 * The counterpart of {@link DB_ERROR_EVENT_KIND}, and the reason it exists is symmetry the capture
 * vocabulary lacked: a statement that RAISED could be described by what it asked, while a statement
 * that SUCCEEDED could only be described by what it returned. A SELECT returning zero rows produced
 * nothing at all, so the operation was wholly invisible.
 */
export const DB_STATEMENT_EVENT_KIND = "db.statement" as const;

/** Canonical event kind for a bounded record of evidence the capture path could not collect. */
export const CAPTURE_GAP_EVENT_KIND = "capture_gap" as const;

/**
 * Canonical event kind for a labeled on-screen numeric snapshot (`k:'ui.num'`).
 * Payload: `{ region, items: [{ label, value, unit? }] }` — labels and parsed
 * numbers only, never raw DOM/HTML.
 */
export const UI_NUM_EVENT_KIND = "ui.num" as const;

/**
 * Canonical event kind for the live event-listener gauge (`k:'ui.listeners'`).
 * Payload: `{ total, byType: [[type, count], …], churnByType: [[type,
 * registrations, removals], …], stk: [[type, stack], …], url }` — counts, and
 * a bounded number of registration call stacks. Never a reference to a target
 * or a listener, and never the listener's own code.
 *
 * `stk` is a NEW data class on this event: application stack text, in the same
 * shape and under the same redaction as the request lane's `stk`. It is bounded
 * four ways — the first registration per (target kind, event type) only, a cap
 * on how many keys are ever captured for, a few frames and a character ceiling
 * per stack, and at most a couple of sites per gauge, each reported once per
 * session. On engines without `Error.captureStackTrace` it is absent rather
 * than guessed at.
 *
 * `byType` is the LIVE count per event type; `churnByType` carries the
 * CUMULATIVE registrations and removals for the same types, in the same order,
 * so a rising live count can be read as what it was — registrations that were
 * never matched by removals, or registrations outpacing them — rather than
 * inferred. Its absence on a reading means the counters were not captured,
 * which is not the same as zero removals.
 */
export const UI_LISTENERS_EVENT_KIND = "ui.listeners" as const;

/**
 * Canonical event kind for the per-navigation layout probe (`k:'ui.layout'`).
 * Payload: `{ dir, lang, scrollW, clientW, overflowX, url }` — document
 * geometry and locale attributes, never content.
 */
export const UI_LAYOUT_EVENT_KIND = "ui.layout" as const;

/**
 * Type specific payload (`d`) of a `k:'capture_gap'` event. `detail` is deliberately a bounded,
 * redacted diagnostic descriptor such as an error name, table and operation, or leading SQL
 * keyword. It must never contain raw SQL values or other user data.
 */
export interface CaptureGapEventData {
  kind: "capture_gap";
  surface: "db_diff" | "backend_request" | "browser" | "queue";
  reason:
    | "unparsed_sql"
    | "uninstrumented_client"
    | "missing_session_id"
    | "capture_exception"
    | "scan_budget_exceeded"
    | "window_miss"
    | "sampled_out"
    | "header_stripped"
    /** A request emitted `backend.req.start` and was closed out without a terminal status. */
    | "request_unterminated"
    /** The event was built but its delivery to the capture endpoint never succeeded. */
    | "delivery_failed"
    /**
     * The remote capture policy never arrived — blocked by a client-side
     * blocker, offline on first load, or an endpoint that answers with no
     * policy at all. Capture fell back to the local config rather than staying
     * closed for the life of the session, and this says so.
     */
    | "policy_unavailable"
    /** Events were dropped from the pending batch because the bus buffer hit its cap. */
    | "buffer_overflow"
    /**
     * Reasons authored by the hosted capture edge rather than by an SDK.
     *
     * The edge writes `k:"capture_gap"` events of its own when it sheds or
     * refuses a batch, so this event kind has two producers. They are listed
     * here because a reader narrowing on `d.kind === "capture_gap"` reads both,
     * and a union that only described the client half made every server
     * authored gap an untyped value the reader had to treat as a free string.
     *
     * The five rejection reasons stay distinct because the customer's next step
     * differs: a card, a plan, fewer sessions, a slower burst, or nothing at all.
     */
    /** Project capture is switched off at the edge. */
    | "kill_switch"
    /** The project's hourly session budget is spent. */
    | "sessions_per_hour"
    /** The project's daily byte budget is spent. */
    | "bytes_per_day"
    /** Tenant burst limiter, before the request was dispatched (429). */
    | "rate_limited_ingest"
    /** Tenant burst limiter inside session start (429). */
    | "rate_limited_session_start"
    /** The trial ended without a subscription (402). */
    | "trial_expired"
    /** The subscription was cancelled after repeated charge failures (402). */
    | "payment_failed"
    /** The monthly session cap for the account's tier is spent (402). */
    | "upgrade_required";
  detail?: string;
  /**
   * How many events the gap accounts for, when the surface can count them.
   *
   * `detail` is a classification, not prose: it keeps SQL keywords, table names
   * and error classes and discards everything else, so a size cannot be carried
   * there. A reader deciding whether a session is worth trusting needs the
   * magnitude — "three events were refused" and "six thousand were" are
   * different sessions.
   */
  droppedEventCount?: number;
  /** Request the gap belongs to, so a reader can join the hole to the request that made it. */
  requestId?: string;
  t: number;
}

/** Mutating operation a `db.diff` event records. */
export type DbDiffOp = "insert" | "update" | "delete";

/**
 * Database engine that produced a `db.diff` / `db.read` event. Downstream consumers (evidence
 * index, fix-context, comparator) treat every engine identically — the engine tag exists so
 * agents and humans know which dialect the captured statement ran against.
 */
export type DbEngine = "postgres" | "mysql" | "mssql" | "sqlite";

/**
 * Type-specific payload (`d`) of a `k:'db.diff'` event: the row(s) that changed for one
 * mutating statement, correlated to the request that caused them via `requestId` (which equals
 * the active request's traceId per the correlation bridge in `correlation.ts`). `after` carries
 * the post-image (insert/update); `before` is the pre-image, only present when before-capture is
 * enabled (and for deletes it carries the removed row). Sensitive columns are redacted out of
 * `after`/`before`/`pk` before the event ever rests. The shape is identical across engines; only
 * the `engine` tag differs.
 */
export interface DbDiffEventData {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  /** Primary-key column→value map identifying the affected row, or `null` when unresolved. */
  pk: Record<string, unknown> | null;
  /** Post-image of the affected row (insert/update); omitted for deletes. */
  after?: Record<string, unknown>;
  /** Pre-image of the affected row; only captured behind the before-capture flag (and for deletes). */
  before?: Record<string, unknown>;
  /**
   * Present only on an image-less statement-level fallback event where per-row images were
   * unobtainable (e.g. a MySQL multi-row insert). Such events carry `pk: null` and no
   * `after`/`before`; this records how many rows the statement changed so the write stays visible.
   */
  rowCount?: number;
  /** Correlation id; equals the active request's traceId so it lands in the same evidence window. */
  requestId: string;
  /** Redaction metadata for any column-level values dropped/masked before rest. */
  redaction?: unknown;
}

/**
 * Type-specific payload (`d`) of a `k:'db.diff.bulk'` event emitted when a mutating statement
 * affects more rows than the configured per-statement `db.diff` cap. It summarizes truncation
 * without duplicating every changed row payload.
 */
export interface DbDiffBulkEventData {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  truncatedRows: number;
  samplePks: Array<Record<string, unknown>>;
}

/**
 * Type-specific payload (`d`) of a `k:'db.read'` event: one redacted row read by a SELECT within
 * an active request scope. Disabled by default because read capture can increase PII surface.
 */
export interface DbReadEventData {
  engine: DbEngine;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  requestId: string;
  /**
   * 1-based ordinal of the SELECT statement within this request.
   *
   * Rows are emitted one event each, so without it N single-row SELECTs and one
   * SELECT returning N rows produce byte-identical evidence — and the whole
   * point of an N+1 finding is telling those two apart.
   */
  stmt?: number;
  /**
   * Normalized shape of the SELECT that produced this row, when the adapter had the statement
   * text. Same subtractive contract as {@link DbStatementEventData.shape}: keywords, identifiers
   * and placeholders only.
   *
   * It rides on the row rather than only on the statement event because a row on its own says what
   * the database held, never what was asked for it. A row that looks correct and a predicate that
   * selected it wrongly are the same evidence until the two are joined.
   */
  shape?: string;
  /**
   * Resolved LIMIT/OFFSET window the statement ran with, when the adapter
   * could parse one. Pagination arithmetic bugs live entirely in this shape: a
   * first-page request whose SELECT ran `OFFSET 1` drops the first row of the
   * table's order from every page without a single error, and only comparing
   * this window against the request's own paging parameters can say so.
   */
  q?: { limit?: number; offset?: number };
  redaction?: unknown;
}

/**
 * Type-specific payload (`d`) of a `k:'db.read.bulk'` event emitted when a SELECT returns more rows
 * than the configured read cap. It proves read volume without resting every row.
 */
export interface DbReadBulkEventData {
  engine: DbEngine;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  truncatedRows: number;
  samplePks: Array<Record<string, unknown>>;
}

/** Operation a `db.error` event records. Wider than `DbDiffOp`: a read can raise too. */
export type DbErrorOp = "select" | "insert" | "update" | "delete" | "other";

/**
 * Type-specific payload (`d`) of a `k:'db.error'` event: one statement that the host issued and
 * the database refused.
 *
 * Every field is an identifier, a classification or a code. **No bind value and no driver error
 * message may ever appear here.** `code` is the database's own error code (`23505`,
 * `ER_DUP_ENTRY`, `SQLITE_CONSTRAINT`), which is a closed vocabulary, and `errorName` is the error
 * class name only — the same stance `captureErrorName` already takes. `shape` is the statement
 * with every literal replaced by a placeholder, so it names what was attempted without carrying
 * what it was attempted with.
 */
export interface DbErrorEventData {
  engine: DbEngine;
  op: DbErrorOp;
  /** Table the statement addressed, or `null` when the statement did not parse to one. */
  table: string | null;
  /** Normalized statement shape: identifiers and keywords only, every literal replaced by `?`. */
  shape: string;
  /** The database's own error code, when the driver reported one. Never a message. */
  code: string | null;
  /** Error class name only, never the message. */
  errorName: string;
  requestId: string;
  t: number;
}

/** Operation a `db.statement` event records. Same vocabulary as {@link DbErrorOp}. */
export type DbStatementOp = DbErrorOp;

/**
 * Type-specific payload (`d`) of a `k:'db.statement'` event: one statement the host issued that
 * the database ACCEPTED.
 *
 * `db.diff` and `db.read` describe a statement only through what it returned, so a statement that
 * returned nothing — a SELECT matching zero rows, a `BEGIN`, an UPDATE that matched nothing —
 * produced no evidence at all, and a statement that DID return rows was described by the rows
 * rather than by what it asked for. Defects in what was ASKED (predicate precedence, a boolean
 * grouping, a filter that is wrong or missing, a lookup that misses) are therefore unreadable
 * whenever the statement executes fine, which is the common case.
 *
 * Same subtractive contract as {@link DbErrorEventData}: `shape` is the statement with every
 * literal replaced by a placeholder, no bind value travels, and `rowCount` is a count and not a
 * row.
 */
export interface DbStatementEventData {
  engine: DbEngine;
  op: DbStatementOp;
  /** Table the statement addressed, or `null` when the statement did not parse to one. */
  table: string | null;
  /** Normalized statement shape: identifiers and keywords only, every literal replaced by `?`. */
  shape: string;
  /**
   * Rows the statement returned or affected, when the driver reported a count; `null` when it did
   * not. `0` is the load-bearing value: it is the only way a lookup that matched nothing is
   * distinguishable from a lookup that never ran.
   */
  rowCount: number | null;
  /** 1-based ordinal of this statement within its request, so execution order survives. */
  seq: number;
  requestId: string;
  t: number;
}

export type InteractionElementDescriptor = Record<string, unknown>;
export type InteractionElementDescriptorFactory = (
  element: Element,
) => InteractionElementDescriptor;

/**
 * Declarative environment input the host app passes to `logger.setEnv`. Both fields are
 * vendor-agnostic free-form maps (no LaunchDarkly/PostHog adapters). Values are redacted
 * through the browser redaction policy before they rest in any `k:'env'` event.
 */
export interface EnvDeclaration {
  /** Active feature flags, e.g. `{ newCheckout: true, plan: 'pro' }`. */
  flags?: Record<string, unknown>;
  /** Runtime config the app wants attached to the session, e.g. `{ region: 'eu' }`. */
  config?: Record<string, unknown>;
}

/**
 * First-party acquisition labels lifted from `utm_*` query parameters. Cross-site advertising
 * click identifiers (`gclid`, `fbclid`, `msclkid`, `ttclid`) are deliberately never captured.
 * Gated behind {@link CrumbtrailConfig.campaign}, which defaults to `false`.
 */
export interface EnvCampaign {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** Display characteristics that change how a rendering defect reproduces. */
export interface EnvDevice {
  /** `devicePixelRatio`. */
  dpr?: number;
  /** Screen size in CSS pixels, distinct from the viewport. */
  screen?: { w: number; h: number };
  /** Screen orientation type, e.g. `portrait-primary`. */
  orientation?: string;
}

/** Network Information API view of the connection, when the runtime exposes it. */
export interface EnvConnection {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

/**
 * Redaction-aware environment snapshot captured once at session start (the `d` payload of a
 * `k:'env'` event with `kind:'snapshot'`). Browser/device fields are best-effort and guarded
 * for non-browser/SSR runtimes; `locale`/`timezone` are available in Node via `Intl`.
 */
export interface EnvSnapshot {
  /**
   * Discriminates the initial full snapshot, a later `setEnv` delta, and a flag-state snapshot
   * emitted at flag or error time.
   */
  kind: "snapshot" | "delta" | "flag-snapshot";
  userAgent?: string;
  browser?: { name: string; version?: string };
  os?: string;
  viewport?: { w: number; h: number };
  locale?: string;
  timezone?: string;
  /** Public client release identity declared by `<meta name="app-build">`. */
  appBuild?: string;
  /** Redacted feature flags declared via `setEnv`. */
  flags?: Record<string, unknown>;
  /** Redacted runtime config declared via `setEnv`. */
  config?: Record<string, unknown>;
  /** `document.referrer` at session start, redaction applied. */
  referrer?: string;
  /** First-party `utm_*` campaign labels. Only present when `campaign` is enabled. */
  campaign?: EnvCampaign;
  device?: EnvDevice;
  connection?: EnvConnection;
  /** `navigator.deviceMemory` in GiB, where exposed. */
  deviceMemory?: number;
  /** `navigator.hardwareConcurrency`. */
  hardwareConcurrency?: number;
  /** Flags that changed since the previous snapshot, keyed by flag name. */
  flagChanges?: Record<string, { from: unknown; to: unknown }>;
  /** Browser redaction metadata for any redacted flag/config values. */
  redaction?: unknown;
}

export interface FlagBugOptions {
  note?: string;
  windowMs?: number;
  tags?: string[];
  voiceBlob?: Blob;
}

/** Pseudonymous identifiers that let a captured artifact join to a support ticket. */
export interface CrumbtrailIdentity {
  accountId?: string;
  userId?: string;
}

/** Remote capture policy polling options. */
export interface CaptureConfigPollingOptions {
  endpoint: string;
  projectKey: string;
  intervalMs?: number;
}

export interface AddBugEventOptions {
  type: string;
  data: Record<string, unknown>;
  schemaVersion?: BugEvent["schemaVersion"];
  platform?: BugEvent["platform"];
  sdk?: BugEvent["sdk"];
  capabilities?: BugEvent["capabilities"];
  target?: BugEvent["target"];
  sessionId?: BugEvent["sessionId"];
  offsetMs?: BugEvent["offsetMs"];
}

export interface CrumbtrailConfig {
  // Module toggles
  console: boolean;
  network: boolean;
  interactions: boolean;
  keystrokes: boolean;
  scroll: boolean;
  visibility: boolean;
  clipboard: boolean;
  errors: boolean;
  performance: boolean;
  cookies: boolean;
  storage: boolean;
  video: boolean;
  audio: boolean;

  // Network
  networkMaxBodySize: number;
  networkExcludeUrls: string[];
  networkCaptureHeaders: boolean;
  networkCorrelationHeaders: boolean;
  networkCorrelationAllowedOrigins: string[];
  /**
   * Network JSON-body redaction policy.
   * - `mode: "structured"` (default): every captured JSON body keeps its
   *   structure; each value goes through the deny-biased v2 classifier and
   *   redacted values carry non-recoverable shape metadata. Tagged
   *   `crumbtrail.browser-redaction.v2`. There is no size threshold: a body
   *   large enough to store is large enough to walk, so redaction strength
   *   never varies with payload size.
   * - `mode: "full"`: restores the v1 whole-body behavior exactly.
   * - `denyFields`: extra field names added to the redaction deny list,
   *   matched as substrings of the compacted (lowercased, alphanumeric-only)
   *   field name — same semantics as the built-in deny tokens.
   * - `keepFields`: field names exempted from the name-based deny rules and
   *   from the free-text catch-all, matched on the whole compacted name rather
   *   than as a substring. Use it when the submitted text IS the defect (a
   *   review body, a search term, a mangled address line) and a shape
   *   placeholder would tell an agent nothing. Value-based detection still
   *   runs inside a kept field, and a `denyFields` entry wins over a keep.
   * - `captureInputValues` (default `true`): whether what a user types is
   *   recorded at all. When recorded it answers to the same deny-biased
   *   classifier as a request body, so a number or a short code survives and
   *   free prose, an email, a card number or a token does not, and a
   *   `password`, `email` or `tel` input is dropped on its type before
   *   anything reads it. Set `false` to opt out entirely: every input value
   *   becomes a placeholder regardless of the field, and `keepFields` cannot
   *   bring one back. Nothing else about redaction changes.
   */
  redaction?: {
    mode?: "structured" | "full";
    denyFields?: string[];
    keepFields?: string[];
    captureInputValues?: boolean;
  };

  // Interaction
  /**
   * Input types masked before the classifier sees the value, for `inp` events
   * and keystrokes alike. Use it for a type whose contents are sensitive
   * whatever was typed into it: the default list masks `number`, so a 2FA code
   * is not kept the way an ordinary quantity is.
   */
  maskInputTypes: string[];
  /**
   * Always masks DOM derived text before it enters the browser ring buffer.
   * Use data-crumbtrail-unmask only on an individual element that is safe to
   * capture.
   */
  maskAllText: true;
  /**
   * Always masks keystrokes, and renders every redacted input value as a mask
   * rather than a placeholder, before either enters the browser ring buffer.
   * Use data-crumbtrail-unmask only on an individual element that is safe to
   * capture.
   *
   * It is not a blanket over captured input values, and describing it as one
   * was wrong: an `inp` event has a field name and a policy, so what it stores
   * is decided by the same deny-biased classifier as a request body — free
   * prose, an email, a card number, a token and a high-entropy secret are
   * redacted, a number or a short code is kept. `maskInputTypes` masks a whole
   * input type ahead of that judgement, and `redaction.captureInputValues:
   * false` is the blanket that stops input values being recorded at all.
   */
  maskAllInputs: true;
  ignoreSelectors: string[];
  describeInteractionElement?: InteractionElementDescriptorFactory;

  // Keystroke
  keystrokeThrottleMs: number;

  // Scroll
  scrollThrottleMs: number;
  scrollElements: string[];

  // Clipboard
  clipboardMaxLength: number;
  captureRawClipboard: boolean;

  // Cookie
  cookiePollIntervalMs: number;
  cookieMaskNames: string[];
  cookieValueMaxLength: number;

  // Storage
  storageValueMaxLength: number;
  storageExcludeKeys: string[];
  captureIdb: boolean;
  captureCacheApi: boolean;

  // Media
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  mediaChunkIntervalMs: number;

  // Ring buffer
  ringBufferMs: number;
  ringBufferMaxEvents: number;

  // Production capture
  /** Explicit consent prevents all buffering until `consent(true)` is called. */
  consentMode: "implicit" | "required";
  /** Treat Global Privacy Control as required consent until `consent(true)` is called. */
  respectGpc: boolean;
  /** Session sampling rate for capture candidates. */
  captureSampleRate: number;
  /** Trigger free baseline session sampling rate. */
  baselineSampleRate: number;
  /** Buffer locally until a trigger fires, then persist the window and tail. */
  flightRecorder: boolean;
  /** Capture duration after a flight recorder trigger before finalizing. */
  flightRecorderTailMs: number;
  /**
   * Poll Crumbtrail for this project's capture settings after initialization.
   *
   * This is what makes the project's settings page reach the running app: the
   * auto flag triggers and their tail, baseline sampling, consent mode, client
   * side masking, switching session replay on, and live probe delivery all
   * arrive on that poll and nowhere else. The kill switch, the capture budgets,
   * row value redaction and the refusal of replay writes are enforced at ingest
   * too, so those hold whatever the client is running, and the poll only lets a
   * client stop buffering sooner. Off by default because the poll is fail
   * closed — capture waits for the first policy response — so a client
   * pointed at something that does not serve the config route must not be
   * switched into waiting for one. Every install path the installer writes
   * sets it, because every one of those points at Crumbtrail.
   *
   * Needs `httpAuthToken`: the poll authenticates with the project ingest key
   * the client already carries, so nothing is configured twice.
   */
  remoteConfig: boolean;
  /**
   * Where that poll goes. Defaults to `/api/capture-config` on `httpEndpoint`,
   * which is where Crumbtrail serves it. Set it only for a self hosted config
   * service that lives somewhere else.
   */
  configEndpoint?: string;
  /**
   * Which app in the project this session belongs to.
   *
   * One ingest key covers a whole project, so the key cannot say which app
   * sent a session — this can. The name is created on first sight and reused
   * after, and a key minted for a single app ignores it. Leave it unset and
   * the session simply carries no app label.
   */
  service?: string;
  /** Config poll cadence when `remoteConfig` is on. */
  configPollIntervalMs: number;

  // Heartbeat
  heartbeat: boolean;

  // Labeled on-screen numeric snapshots (`k:'ui.num'`)
  uiNumbers: boolean;

  // Live event-listener gauge (`k:'ui.listeners'`)
  listeners: boolean;

  // Server-sent events lifecycle (`k:'net.sse'`)
  eventSource: boolean;

  // WebSocket lifecycle and redacted frames (`k:'net.ws'`)
  webSocket: boolean;

  // Worker lifecycle and redacted messages (`k:'worker.msg'`)
  workers: boolean;

  // Environment snapshot
  environment: boolean;

  /**
   * Capture first-party `utm_*` campaign labels into the environment snapshot. A sub-behaviour
   * of the `environment` collector, not a collector of its own. Defaults to `false`: enabling it
   * by default is a privacy commitment that needs founder sign off.
   */
  campaign: boolean;

  // Widget
  widget: boolean;

  // State capture
  stateMaxBytes: number;
  captureRawState: boolean;

  // Auto-flag on error: snapshot the ring buffer automatically when an err/rej event fires.
  autoFlagOnError: boolean;
  /** Enable automatic capture for uncaught browser errors. */
  autoFlagOnUncaughtError: boolean;
  /** Enable automatic capture for unhandled promise rejections. */
  autoFlagOnUnhandledRejection: boolean;
  /**
   * Enable automatic capture for instrumented HTTP 5xx responses. On by
   * default.
   *
   * A 5xx an app handles gracefully — caught, rendered as an empty state, no
   * console error, no retry — is otherwise invisible to every other trigger,
   * which is exactly the silent-failure class capture exists for. The cost of
   * being wrong here is one extra session; the cost of missing it is a bug
   * nobody can reproduce. `autoFlagDebounceMs` coalesces a burst and
   * `autoFlagMaxPerSession` caps the total, so an outage cannot flood.
   */
  autoFlagOnRequest5xx: boolean;
  /** Allow app code and the widget to call `flag()` as an explicit beacon. */
  explicitBeacon: boolean;
  /** Keep the server side pull policy available to heartbeat integrations. */
  serverSidePull: boolean;
  // Quiet period after the last new error before the auto-flag fires. Doubles as post-roll:
  // the snapshot window then includes the cascade's aftermath, and a burst costs one report.
  autoFlagDebounceMs: number;
  // Hard cap on auto-captured reports per session (shared across every auto-flag detector).
  autoFlagMaxPerSession: number;

  // Precognitive auto-flag: snapshot the ring buffer on behavioral leading indicators of a silent
  // failure (rage-clicks, retry storms) — before an error throws, or when none ever does. Opt-in.
  autoFlagOnSignals: boolean;
  /** Per-signal switches let a remote policy enable only the selected behavioral triggers. */
  autoFlagOnRageClick: boolean;
  autoFlagOnRetryStorm: boolean;
  autoFlagOnSlowResponse: boolean;
  autoFlagOnAbandonedFlow: boolean;
  // Clicks on the same target within rageClickWindowMs that trip a rage-click auto-flag.
  rageClickThreshold: number;
  rageClickWindowMs: number;
  // Requests to the same endpoint within retryStormWindowMs that trip a retry-storm auto-flag.
  retryStormThreshold: number;
  retryStormWindowMs: number;
  // Failed responses (status >= 400) to the same endpoint within retryStormWindowMs that trip it.
  retryStormFailThreshold: number;
  // Responses at/above slowRequestMs, this many within slowRequestWindowMs, trip a slow-responses auto-flag.
  slowRequestMs: number;
  slowRequestCount: number;
  slowRequestWindowMs: number;
  // Page hidden within abandonedFlowWindowMs of the last of >= abandonedFlowMinInputs unsubmitted
  // inputs trips an abandoned-flow auto-flag.
  abandonedFlowWindowMs: number;
  abandonedFlowMinInputs: number;

  // DOM snapshot captured at flag time (one-shot outerHTML, redacted; cheap once, costly to stream).
  domSnapshot: boolean;
  domSnapshotMaxBytes: number;

  // Privacy opt-ins
  captureRawConsole: boolean;
  captureRawErrors: boolean;

  // Transport
  transport: "auto" | "tauri" | "http";
  transportInstance?: CrumbtrailTransport;
  httpEndpoint: string;
  httpAuthToken?: string;
  flushIntervalMs: number;
  flushBufferSize: number;
  /**
   * Close the session when the page goes away (`pagehide`: tab close or
   * navigation) or becomes hidden (`visibilitychange`). A bfcache entry keeps
   * the session open. On by default in a browser.
   *
   * Without it nothing ends a session that the host never calls `stop()` on,
   * and the server only reclaims it through the idle sweeper — 30 minutes of
   * idleness, checked every 5, so a session stayed unreadable for around 35
   * minutes after the person closed the tab. The end request goes out with
   * `keepalive`, so it survives the unload and still carries the ingest key.
   */
  endOnPageHide: boolean;

  // Blob sender (wired from transport by default; override for custom handling)
  sendBlob?: (name: string, blob: Blob) => void;

  // Session continuity
  // 'session' (default in browser): persist the session id in sessionStorage so a hard page
  //   reload within the idle window reuses the same session instead of minting a new one.
  // 'memory' / 'none': never persist — every init() mints a fresh session id.
  sessionPersistence: "session" | "memory" | "none";
  // Rolling idle window (ms). A persisted session older than this is treated as stale.
  sessionIdleMs: number;
  // Explicit session id override. When set, it always wins and is persisted (if persistence is on).
  sessionId?: string;
  // Optional platform storage adapter. Defaults to browser sessionStorage when available.
  sessionStore?: SessionStore;
}

export const DEFAULT_CONFIG: CrumbtrailConfig = {
  console: true,
  network: true,
  interactions: true,
  keystrokes: true,
  scroll: true,
  visibility: true,
  clipboard: true,
  errors: true,
  performance: true,
  cookies: true,
  storage: true,
  video: false,
  audio: false,

  networkMaxBodySize: 51200,
  networkExcludeUrls: [],
  networkCaptureHeaders: true,
  networkCorrelationHeaders: true,
  networkCorrelationAllowedOrigins: [],

  maskInputTypes: ["password", "email", "tel", "number", "search", "url"],
  maskAllText: true,
  maskAllInputs: true,
  ignoreSelectors: [],

  keystrokeThrottleMs: 0,

  scrollThrottleMs: 500,
  scrollElements: [],

  clipboardMaxLength: 500,
  captureRawClipboard: false,

  cookiePollIntervalMs: 2000,
  cookieMaskNames: [],
  cookieValueMaxLength: 500,

  storageValueMaxLength: 500,
  storageExcludeKeys: [],
  captureIdb: true,
  captureCacheApi: true,

  videoBitsPerSecond: 1_000_000,
  audioBitsPerSecond: 64_000,
  mediaChunkIntervalMs: 10_000,

  ringBufferMs: 300_000,
  ringBufferMaxEvents: 50_000,

  consentMode: "implicit",
  respectGpc: true,
  captureSampleRate: 1,
  baselineSampleRate: 0,
  flightRecorder: false,
  flightRecorderTailMs: 60_000,
  remoteConfig: false,
  configPollIntervalMs: 60_000,

  heartbeat: true,

  uiNumbers: true,

  listeners: true,

  eventSource: true,

  webSocket: true,

  workers: true,

  environment: true,

  campaign: false,

  widget: false,

  stateMaxBytes: 32_768,
  captureRawState: false,

  autoFlagOnError: false,
  autoFlagOnUncaughtError: true,
  autoFlagOnUnhandledRejection: true,
  autoFlagOnRequest5xx: true,
  explicitBeacon: true,
  serverSidePull: false,
  autoFlagDebounceMs: 2000,
  autoFlagMaxPerSession: 10,

  autoFlagOnSignals: false,
  autoFlagOnRageClick: true,
  autoFlagOnRetryStorm: true,
  autoFlagOnSlowResponse: true,
  autoFlagOnAbandonedFlow: true,
  rageClickThreshold: 4,
  rageClickWindowMs: 1500,
  retryStormThreshold: 4,
  retryStormWindowMs: 5000,
  retryStormFailThreshold: 2,
  slowRequestMs: 3000,
  slowRequestCount: 3,
  slowRequestWindowMs: 10000,
  abandonedFlowWindowMs: 30000,
  abandonedFlowMinInputs: 2,

  domSnapshot: true,
  domSnapshotMaxBytes: 262_144,

  captureRawConsole: false,
  captureRawErrors: false,

  transport: "auto",
  httpEndpoint: "http://localhost:9898",
  httpAuthToken: "",
  flushIntervalMs: 5000,
  flushBufferSize: 100,
  endOnPageHide: true,

  sessionPersistence: "session",
  sessionIdleMs: 1_800_000, // 30 minutes
};

export type CrumbtrailPreset = "full" | "light" | "passive";

export const PRESET_FULL: Partial<CrumbtrailConfig> = {
  widget: true,
  autoFlagOnError: true,
  autoFlagOnSignals: true,
};

export const PRESET_LIGHT: Partial<CrumbtrailConfig> = {
  keystrokes: false,
  video: false,
  audio: false,
  clipboard: false,
  cookies: false,
  storage: false,
  performance: false,
  // Full-DOM numeric scans are against LIGHT's minimal-overhead posture.
  uiNumbers: false,
  // So is a patch on the hottest DOM method there is.
  listeners: false,
};

// Embedded end-user monitoring: no widget, but silently auto-capture the reproduction window
// on both errors and behavioral leading indicators (rage-clicks, retry storms).
export const PRESET_PASSIVE: Partial<CrumbtrailConfig> = {
  autoFlagOnError: true,
  autoFlagOnSignals: true,
};

export type CollectorCleanup = () => void;

export interface CollectorContext {
  sessionId: string;
  /**
   * Returns env declared via `setEnv` before the snapshot is emitted so the environment
   * collector can fold it into the initial `k:'env'` snapshot. Absent for other collectors.
   */
  getDeclaredEnv?: () => EnvDeclaration;
  /** Called by the environment collector once the initial snapshot has been emitted. */
  onEnvEmitted?: () => void;
  /**
   * Lets a collector expose live diagnostic state (e.g. in-flight requests) that is snapshotted
   * at flag time through the same redaction/truncation path as app state providers.
   */
  registerStateProvider?: (name: string, provider: () => unknown) => () => void;
  /**
   * Settles once admission has been DECIDED, with whether capture may proceed.
   *
   * A collector holding evidence that cannot be re-read — the one-shot
   * `crumbtrail-core/early` queue is the only one today — must not emit it while
   * the bus is still refusing events, because a refused event is gone for good.
   * `true` means release it now, `false` means discard it. Absent means there is
   * no gate to wait on, so release immediately.
   */
  whenCaptureAdmitted?: (settle: (admitted: boolean) => void) => void;
}

export interface CrumbtrailTransport {
  sendEvents(events: BugEvent[]): Promise<void>;
  sendBlob(
    name: string,
    blob: Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  sendBugReport(
    report: BugReport,
    events: BugEvent[],
    voiceBlob?: Blob,
  ): Promise<void>;
}
