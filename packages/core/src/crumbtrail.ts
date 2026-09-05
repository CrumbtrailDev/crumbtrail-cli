import { EventBus, type EmitContext } from "./event-bus";
import { RingBuffer } from "./ring-buffer";
import type {
  AddBugEventOptions,
  BugEvent,
  CaptureConfigPollingOptions,
  CrumbtrailConfig,
  CrumbtrailIdentity,
  CrumbtrailPreset,
  CrumbtrailTransport,
  BugReport,
  CollectorCleanup,
  CollectorContext,
  BugFlagOrigin,
  FlagBugOptions,
  InternalFlagOptions,
  RecordErrorOptions,
} from "./types";
import {
  DEFAULT_CONFIG,
  PRESET_FULL,
  PRESET_LIGHT,
  PRESET_PASSIVE,
} from "./types";
import { createCrumbtrailRequestHeaders } from "./correlation";
import { readEarlySessionId } from "./early-capture";
import { createAutoFlagController, type AutoFlagController } from "./auto-flag";
import {
  ReplayRecorder,
  replaySupported,
  type ReplayMasking,
} from "./replay/index";
import {
  isProbeName,
  runProbe,
  type ProbeContext,
  type ProbeName,
} from "./probes";
import {
  errorDetector,
  requestFailureDetector,
  caughtErrorDetector,
  responseBodyErrorDetector,
  streamFailureDetector,
  workerErrorDetector,
  wrongNumberDetector,
  resourceLoadFailureDetector,
  storageFailureDetector,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
  renderedErrorDetector,
  type SignalDetector,
} from "./signals";

const PRESETS: Record<CrumbtrailPreset, Partial<CrumbtrailConfig>> = {
  full: PRESET_FULL,
  light: PRESET_LIGHT,
  passive: PRESET_PASSIVE,
};
import { generateSessionId, now } from "./utils";
import { HttpTransport } from "./transports/http";
import {
  createRuntimeBindingClient,
  type RuntimeBinding,
  type RuntimeBindingClient,
} from "./runtime-binding";
import { createWebSessionStore, type SessionStore } from "./session-store";
import { consoleCollector } from "./collectors/console";
import { errorCollector, buildRecordedErrorData } from "./collectors/error";
import { interactionCollector } from "./collectors/interaction";
import { keystrokeCollector } from "./collectors/keystroke";
import { scrollCollector } from "./collectors/scroll";
import { visibilityCollector } from "./collectors/visibility";
import { clipboardCollector } from "./collectors/clipboard";
import { cookieCollector } from "./collectors/cookie";
import { storageCollector } from "./collectors/storage";
import { networkCollector } from "./collectors/network";
import { performanceCollector } from "./collectors/performance";
import { heartbeatCollector } from "./collectors/heartbeat";
import { uiNumbersCollector } from "./collectors/ui-numbers";
import { listenerCollector } from "./collectors/listeners";
import { eventSourceCollector } from "./collectors/eventsource";
import { webSocketCollector } from "./collectors/websocket";
import { workerCollector } from "./collectors/worker";
import { environmentCollector, buildEnvDelta } from "./collectors/environment";
import type { EnvDeclaration, EnvSnapshot } from "./types";
// `diffFlags` is an implementation detail of `setEnv`, not SDK surface an integrator calls, and
// stays unexported. `normalizeFlagValue` is exported from `index.ts` because `crumbtrail-node`
// has to read the same wrapper shape back out of captured events.
import { diffFlags, type NormalizedFlag } from "./flags";
import {
  attachRedactionMetadata,
  mergeRedactionMetadata,
  REDACTED_VALUE,
  redactDiagnosticFields,
  redactNetworkTextBody,
  redactUrl,
  redactValue,
  type PayloadSummary,
  type RedactionMetadata,
  setCaptureInputValues,
  setRedactionKeepFields,
} from "./redaction";
import { buildCaptureGapEvent } from "./capture-gap";
import {
  COLLECTOR_EVENT_KINDS,
  readMaskingState,
  reapplyPolicyToHeldEvent,
  type HeldEvent,
  type MaskingState,
} from "./admission-hold";
import {
  CRUMBTRAIL_SDK_VERSION,
  readApplicationReleaseIdentity,
  type ApplicationReleaseIdentity,
} from "./release-identity";
import { renderedErrorCollector } from "./collectors/rendered-error";
import {
  generateReportScreenshotArtifactName,
  isReportScreenshotArtifactName,
  prepareReportScreenshot,
  type CaptureScreenshotOptions,
} from "./screenshot";
import {
  buildApplicationAssertionEvent,
  MAX_APPLICATION_ASSERTIONS_PER_SESSION,
  type ApplicationAssertionOptions,
  type ApplicationAssertionResult,
} from "./assertion";
import {
  checkApplicationResponse,
  createApplicationExpectationManager,
  MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION,
  MAX_APPLICATION_EXPECTATIONS_PER_SESSION,
  type ApplicationExpectationOptions,
  type ApplicationExpectationResult,
  type ApplicationResponseCheckResult,
  type ApplicationResponseCorrelation,
  type ApplicationResponseFactOptions,
} from "./application-contracts";

/** Cap on delivery-failure gap records per session. */
const MAX_DELIVERY_GAP_EVENTS = 3;
/**
 * Ceiling on events held while admission is undecided. The window is normally
 * one config round trip, so this is a guard against a policy route that never
 * answers rather than a working limit; what it discards is declared as a
 * `capture_gap` when the gate finally opens.
 */
const MAX_PENDING_ADMISSION_EVENTS = 2_000;

/**
 * Byte ceiling on the same hold, because the count alone does not bound it.
 *
 * Under `consentMode: "required"` the hold waits for a `consent()` call that
 * may never come, and 2,000 events is a small number when one of them is a DOM
 * snapshot capped at 256 KB. 4 MB is roughly the largest first screen worth
 * keeping and well under what a page can spare; past it the oldest events go,
 * counted as `buffer_overflow` like any other cap.
 */
const MAX_PENDING_ADMISSION_BYTES = 4_194_304;

/**
 * Size of one held event, for the byte ceiling above.
 *
 * `JSON.stringify` is what the transport will do to this event anyway, so it
 * measures the thing being bounded rather than a proxy for it. A payload that
 * cannot be serialized is counted at zero: it will not reach the wire either,
 * and a throw here would lose an event to a measurement.
 */
function estimateHeldEventBytes(event: BugEvent): number {
  try {
    return JSON.stringify(event)?.length ?? 0;
  } catch {
    return 0;
  }
}
import { buildMaskedDomSnapshot, maskText } from "./masking";
import { CAPTURE_GAP_EVENT_KIND } from "./types";

type Collector = (
  bus: EventBus,
  config: CrumbtrailConfig,
  context: CollectorContext,
) => CollectorCleanup;

interface StopFailure {
  label: string;
  error: unknown;
}

function recordStopFailure(
  failures: StopFailure[],
  label: string,
  error: unknown,
): void {
  if (error instanceof AggregateError) {
    error.errors.forEach((nested, index) =>
      recordStopFailure(failures, `${label}[${index}]`, nested),
    );
    return;
  }
  failures.push({ label, error });
}

function buildStopFailure(failures: readonly StopFailure[]): AggregateError {
  const errors = failures.map(
    ({ label, error }) => new Error(label, { cause: error }),
  );
  return new AggregateError(
    errors,
    "Crumbtrail.stop() completed with teardown failures",
  );
}

export const COLLECTOR_MAP: Record<string, Collector> = {
  environment: environmentCollector,
  console: consoleCollector,
  errors: errorCollector,
  interactions: interactionCollector,
  keystrokes: keystrokeCollector,
  scroll: scrollCollector,
  visibility: visibilityCollector,
  clipboard: clipboardCollector,
  cookies: cookieCollector,
  storage: storageCollector,
  network: networkCollector,
  performance: performanceCollector,
  heartbeat: heartbeatCollector,
  uiNumbers: uiNumbersCollector,
  listeners: listenerCollector,
  eventSource: eventSourceCollector,
  webSocket: webSocketCollector,
  workers: workerCollector,
};

const DEFAULT_CONFIG_POLL_INTERVAL_MS = 60_000;

/**
 * How long capture waits for the remote capture policy before falling back to
 * the local config.
 *
 * `remoteConfig` is on by default and every generated init block carries a key,
 * so this bound applies to ordinary installs rather than to an opt in few. Until
 * the policy lands `canTransport()` is false, so the whole session is refused at
 * admission. Without a bound, a blocked config
 * route, an offline first load, or an endpoint that answers with no policy at
 * all means a session that captures nothing, forever, and cannot even say so —
 * the gap record needs `canTransport()` too. The wait is bounded instead, and
 * the fallback declares itself with a `policy_unavailable` gap.
 */
export const REMOTE_POLICY_TIMEOUT_MS = 5_000;
const SESSION_METADATA_STOP_TIMEOUT_MS = REMOTE_POLICY_TIMEOUT_MS;
const EMAIL_SHAPED_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/**
 * There is no terminal state: a recorder that has finalized a window re-arms to
 * "buffering" for the next one, because a session's second failure deserves a
 * report as much as its first.
 */
type FlightRecorderState =
  "armed" | "buffering" | "triggered" | "tailing" | "finalizing";
/**
 * The event a probe result rests as. One event per probe, carrying the whole {@link ProbeResult}
 * including a failed one, because "the probe ran and could not answer" is itself the answer to
 * "is this source available in production".
 */
export const PROBE_RESULT_EVENT_KIND = "probe.result";

/**
 * Probes accepted from a single config poll. Probes run inside a customer's live application, so
 * the server cannot ask for an unbounded amount of work; anything past this is dropped.
 */
const MAX_REMOTE_PROBES = 4;

/**
 * Entries scanned in a `probes` array before the field is refused outright. A legitimate request
 * names at most {@link MAX_REMOTE_PROBES} probes, so a longer list is not a request, and scanning
 * it would be work an unauthenticated response body chose for us.
 */
const MAX_REMOTE_PROBE_ENTRIES = 64;

/**
 * Entries accepted in a remote string list (`network.excludeUrls`, `redaction.denyFields`).
 * A longer list is refused whole: these are matched against every request and every field name,
 * so an unbounded list is per-event work an unauthenticated response body chose for us.
 */
const MAX_REMOTE_STRING_LIST_ENTRIES = 256;

/**
 * Throttles a remote policy sets outright. Each one only decides how often an already-running
 * collector emits, so neither direction changes what kind of data the application agreed to
 * capture: a lower value is more of the same events, a higher one is fewer.
 */
const REMOTE_THROTTLE_KEYS = [
  "keystrokeThrottleMs",
  "scrollThrottleMs",
] as const satisfies ReadonlyArray<keyof CrumbtrailConfig>;

/**
 * Size caps a remote policy may lower and never raise, applied as `min(remote, init)` in the
 * same way as `networkMaxBodySize`.
 *
 * Each one bounds how much of a value rests inside an event — clipboard text, a storage value, a
 * serialized state blob, a DOM snapshot. Raising one puts more of the user's own data in the
 * payload than the init block agreed to, which is the definition of loosening, so the poll may
 * only cut them down.
 */
const REMOTE_SIZE_LIMIT_KEYS = [
  "clipboardMaxLength",
  "storageValueMaxLength",
  "stateMaxBytes",
  "domSnapshotMaxBytes",
] as const satisfies ReadonlyArray<keyof CrumbtrailConfig>;

type RemoteSizeLimitKey = (typeof REMOTE_SIZE_LIMIT_KEYS)[number];

/**
 * Floor on `ringBufferMs` a remote policy may ask for. Retention below a second is not a
 * recording window, it is an empty buffer with a flagged bug cut from nothing.
 */
const MIN_REMOTE_RING_BUFFER_MS = 1_000;

const REMOTE_CONFIG_KEYS = [
  "captureSampleRate",
  "baselineSampleRate",
  "flightRecorder",
  "flightRecorderTailMs",
  "reportScreenshotsEnabled",
  "autoFlagOnError",
  "autoFlagOnUncaughtError",
  "autoFlagOnUnhandledRejection",
  "autoFlagOnRequest5xx",
  "autoFlagOnRenderedError",
  "autoFlagOnCaughtError",
  "autoFlagOnResponseBodyError",
  "autoFlagOnStreamFailure",
  "autoFlagOnWorkerError",
  "autoFlagOnWrongNumber",
  "autoFlagOnResourceLoadFailure",
  "autoFlagOnStorageFailure",
  "explicitBeacon",
  "serverSidePull",
  "autoFlagOnSignals",
  "autoFlagOnRageClick",
  "autoFlagOnRetryStorm",
  "autoFlagOnSlowResponse",
  "autoFlagOnAbandonedFlow",
  "autoFlagDebounceMs",
  "autoFlagMaxPerSession",
  "rageClickThreshold",
  "rageClickWindowMs",
  "retryStormThreshold",
  "retryStormWindowMs",
  "retryStormFailThreshold",
  "slowRequestMs",
  "slowRequestCount",
  "slowRequestWindowMs",
  "abandonedFlowWindowMs",
  "abandonedFlowMinInputs",
  ...REMOTE_THROTTLE_KEYS,
] as const satisfies ReadonlyArray<keyof CrumbtrailConfig>;

/**
 * Collector switches a remote policy may turn on or off.
 *
 * Read from a nested `collectors` object rather than the top level, so a field named after a
 * collector elsewhere in the response envelope cannot silently turn a collector off.
 *
 * `video`, `audio` and `widget` are deliberately absent: media capture and the on-screen widget
 * are the host application's decision, not a policy dial.
 */
const REMOTE_COLLECTOR_KEYS = [
  "console",
  "network",
  "interactions",
  "keystrokes",
  "scroll",
  "visibility",
  "clipboard",
  "errors",
  "performance",
  "cookies",
  "storage",
  "heartbeat",
  "uiNumbers",
  "listeners",
  "eventSource",
  "webSocket",
  "workers",
  "environment",
  "campaign",
  "domSnapshot",
] as const satisfies ReadonlyArray<keyof CrumbtrailConfig>;

type RemoteCollectorKey = (typeof REMOTE_COLLECTOR_KEYS)[number];

/**
 * Every switch the policy can flip has to mean something when the admission
 * hold releases events under it, or turning that collector off leaves its held
 * events to ship anyway. This assignment is the only thing that catches a new
 * switch added here and not there: it fails to compile until
 * `COLLECTOR_EVENT_KINDS` covers the key.
 */
const _collectorKindsCoverEverySwitch: Record<
  RemoteCollectorKey,
  readonly string[]
> = COLLECTOR_EVENT_KINDS;
void _collectorKindsCoverEverySwitch;

/**
 * Collectors a switch can stop mid-session but cannot start again.
 *
 * Every collector in {@link COLLECTOR_MAP} tears down on demand, so OFF is always live. Starting
 * again is the narrower claim, and one collector cannot make it:
 *
 * - `performance` observes with `buffered: true`, which is what reports the navigation and
 *   paint entries that fired before init. A second instance therefore replays the whole load
 *   timeline the first one already emitted, and its vitals finalizers (`inp`, `cls.score`,
 *   `lcp.final`) ran at teardown, so a restart would rest a second, partial set of final scores
 *   over the real ones. Turning it back on waits for the next page load, where those readings
 *   are true again.
 *
 * A key in this set still stops immediately; only the ON edge is deferred.
 */
export const OFF_ONLY_COLLECTORS: ReadonlySet<string> = new Set([
  "performance",
]);

/**
 * The local values a remote policy is allowed to tighten but never loosen, snapshotted at
 * `init()`. Held separately from the live config because the live config is what a poll writes
 * to: comparing a second poll against an already-tightened value would let a sequence of polls
 * ratchet a limit back up one step at a time.
 */
interface LocalCaptureFloor {
  networkMaxBodySize: number;
  networkExcludeUrls: readonly string[];
  networkCaptureHeaders: boolean;
  redactionMode: "structured" | "full";
  redactionDenyFields: readonly string[];
  sizeLimits: Readonly<Record<RemoteSizeLimitKey, number>>;
  ringBufferMs: number;
  ringBufferMaxEvents: number;
  /**
   * Each collector's switch as `init()` left it. A collector the application never turned on is
   * data it never agreed to capture, so a poll may only switch one off, or switch one back on
   * that an earlier poll switched off.
   */
  collectors: Readonly<Record<RemoteCollectorKey, boolean>>;
}

/**
 * Minimum spacing between severity-triggered flushes. An error storm must not
 * become a request storm: the first severe event flushes immediately, the
 * rest ride the next interval flush. Only tap-triggered flushes are
 * rate-limited — interval, buffer-size, flagBug, stop, and resume flushes are
 * never affected.
 */
const SEVERITY_FLUSH_MIN_INTERVAL_MS = 1000;

/**
 * Give a page entering the back forward cache time to announce that it is a
 * persisted transition before treating a visibility change as a session end.
 * The timer is zero by design: it yields to the rest of the lifecycle events
 * in the same turn, while a page that is merely backgrounded still closes on
 * the next turn.
 */
const PAGE_HIDDEN_END_DELAY_MS = 0;

/**
 * A nonpersisted pagehide cannot keep a browser alive for an arbitrary upload. Give already
 * admitted sends a short chance to finish, then leave the session open for the server's TTL
 * rather than ending it ahead of evidence that may still be on the wire.
 */
export const PAGEHIDE_PENDING_SEND_TIMEOUT_MS = 5_000;

/**
 * Transport that drops every call. Backs the inert instance returned when
 * `init()` runs outside a browser, guaranteeing no socket is opened during SSR
 * or a build step.
 */
const INERT_TRANSPORT: CrumbtrailTransport = {
  async sendEvents() {},
  async sendBlob() {},
  async startSession() {},
  async endSession() {},
  async sendBugReport() {},
};

function bodyPlaceholder(summary: PayloadSummary | undefined): string {
  return summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]";
}

function readPersistedSessionId(
  store: SessionStore,
  idleMs: number,
):
  | {
      id: string;
      applicationAssertionCount: number;
      applicationResponseAssertionCount: number;
      applicationExpectationCount: number;
    }
  | undefined {
  try {
    const persisted = store.read();
    if (!persisted || typeof persisted !== "object") return undefined;
    const id = persisted.id;
    const lastActivity = persisted.lastActivity;
    const applicationAssertionCount = persisted.applicationAssertionCount;
    const applicationExpectationCount = persisted.applicationExpectationCount;
    if (
      applicationExpectationCount !== undefined &&
      (typeof applicationExpectationCount !== "number" ||
        !Number.isSafeInteger(applicationExpectationCount) ||
        applicationExpectationCount < 0 ||
        applicationExpectationCount > MAX_APPLICATION_EXPECTATIONS_PER_SESSION)
    )
      return undefined;
    const applicationResponseAssertionCount =
      persisted.applicationResponseAssertionCount;
    if (
      applicationResponseAssertionCount !== undefined &&
      (typeof applicationResponseAssertionCount !== "number" ||
        !Number.isSafeInteger(applicationResponseAssertionCount) ||
        applicationResponseAssertionCount < 0 ||
        applicationResponseAssertionCount >
          MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION)
    )
      return undefined;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof lastActivity !== "number" ||
      !Number.isSafeInteger(lastActivity) ||
      lastActivity < 0 ||
      (applicationAssertionCount !== undefined &&
        (typeof applicationAssertionCount !== "number" ||
          !Number.isSafeInteger(applicationAssertionCount) ||
          applicationAssertionCount < 0 ||
          applicationAssertionCount > MAX_APPLICATION_ASSERTIONS_PER_SESSION))
    )
      return undefined;
    if (now() - lastActivity > idleMs) return undefined; // stale -> mint a fresh session
    return {
      id,
      applicationAssertionCount: applicationAssertionCount ?? 0,
      applicationResponseAssertionCount: applicationResponseAssertionCount ?? 0,
      applicationExpectationCount: applicationExpectationCount ?? 0,
    };
  } catch {
    return undefined;
  }
}

function writePersistedSession(
  store: SessionStore,
  id: string,
  applicationAssertionCount = 0,
  applicationResponseAssertionCount = 0,
  applicationExpectationCount = 0,
): void {
  try {
    store.write({
      id,
      lastActivity: now(),
      applicationAssertionCount,
      applicationResponseAssertionCount,
      applicationExpectationCount,
    });
  } catch {
    // Persistence is best effort. A custom store must not break capture.
  }
}

/**
 * The result of a flag request. `flagBug` hands the caller only `bugId`, because a person
 * asking for a report gets an identifier either way. The auto flag controller needs
 * `captured`: its per-session cap counts reports that exist, and a request the capture path
 * declined — consent withdrawn, sampled out, kill switch on, a flight recorder window already
 * finalizing — must not spend one.
 */
interface FlagOutcome {
  bugId: string;
  captured: boolean;
}

export class Crumbtrail {
  private bus: EventBus;
  private transport: CrumbtrailTransport;
  private ringBuffer: RingBuffer;
  private cleanups: CollectorCleanup[] = [];
  private config: CrumbtrailConfig;
  private readonly localCaptureFloor: LocalCaptureFloor;
  /**
   * Collector switches the last poll changed. Read by
   * {@link Crumbtrail.applyRemoteCollectorChanges} to start and stop collectors mid-session.
   */
  private remoteCollectorChanges: RemoteCollectorKey[] = [];
  /**
   * Teardown for each {@link COLLECTOR_MAP} collector currently installed, keyed by its config
   * name. Held apart from `cleanups` — which is one flat list torn down only at `stop()` —
   * because a policy switch has to reach exactly one collector's teardown and leave the rest
   * running. Presence in this map is also what makes a start idempotent: a collector already in
   * it is never installed a second time.
   */
  private collectorTeardowns = new Map<string, CollectorCleanup>();
  /**
   * Collectors whose teardown threw, for the rest of the session.
   *
   * A teardown that throws part way leaves its patches half-installed — some globals restored,
   * some still wrapped — and nothing here can tell which. Installing that collector again would
   * wrap the survivors a second time, so every request it sees is captured twice and the
   * original is buried one layer deeper. Refusing the re-install keeps the session on the half
   * that is still running rather than stacking a second copy on top of it.
   */
  private poisonedCollectors = new Set<string>();
  /** The context handed to collectors at init, kept so a later start hands over the same one. */
  private collectorContext?: CollectorContext;
  /** Storage-failure hooks follow trigger changes without restarting the storage collector. */
  private storageFailureSyncs = new Set<() => void>();
  private sessionId: string;
  private applicationAssertions = 0;
  private pendingApplicationAssertions = 0;
  private applicationResponseAssertions = 0;
  private pendingApplicationResponseAssertions = 0;
  private applicationExpectations: ReturnType<
    typeof createApplicationExpectationManager
  >;
  private widgetCleanup?: () => void;
  /** Names uploaded by this live session and therefore eligible for association. */
  private visualArtifactNames = new Set<string>();
  private stateProviders = new Map<string, () => unknown>();
  private declaredFlags: Record<string, unknown> = {};
  private declaredConfig: Record<string, unknown> = {};
  private envEmitted = false;
  private autoFlagCleanup?: () => void;
  private autoFlag?: AutoFlagController;
  private configPollingCleanup?: () => void;
  private configPollGeneration = 0;
  /** Per tab runtime binding. Never copied into metadata or emitted events. */
  private runtimeBinding?: RuntimeBindingClient;
  private flightRecorderTimer?: ReturnType<typeof setTimeout>;
  private flightRecorderFinalization?: Promise<FlagOutcome>;
  private flightRecorderTailResolver?: (result: FlagOutcome) => void;
  private flightRecorderState: FlightRecorderState = "armed";
  private consentGranted: boolean;
  private explicitConsent?: boolean;
  private killSwitch = false;
  private remotePolicyReady: boolean;
  private remotePolicyTimer?: ReturnType<typeof setTimeout>;
  /**
   * Collectors holding evidence that cannot be re-read, waiting for admission
   * to be decided. See `CollectorContext.whenCaptureAdmitted`.
   */
  private admissionWaiters: Array<(admitted: boolean) => void> = [];
  /**
   * Events emitted while admission was still UNDECIDED, kept until it is.
   *
   * Refusing them outright destroys evidence that cannot be produced again, and
   * it does so asymmetrically: a request that starts before the capture policy
   * lands and answers after it keeps its `net.res` and loses its `net.req`, so
   * the session shows a response with no call behind it. The window is the
   * standard configuration — `remoteConfig: true` is what the installer writes
   * — and it covers exactly the requests that render the first screen.
   *
   * Held only while the answer is genuinely pending. A denial (`stop()`, kill
   * switch, `consent(false)`, Global Privacy Control) drops the events without
   * ever transporting them, which is the same outcome refusing them had.
   */
  private pendingAdmissionEvents: HeldEvent[] = [];
  /** Events the hold discarded to stay under its caps, as one `capture_gap`. */
  private pendingAdmissionDropped = 0;
  /** Running total of the held events' sizes, kept under the byte ceiling. */
  private pendingAdmissionBytes = 0;
  /**
   * The masking switches in force when the hold started. A policy that tightens
   * them cannot be applied retroactively to content already rendered into an
   * event, so the release pass drops those events instead of guessing.
   */
  private pendingAdmissionMasking?: MaskingState;
  /** Guards against a released event being re-held by its own emit. */
  private releasingAdmissionHold = false;
  private samplingShed: boolean;
  private samplingGapEmitted = false;
  /** Bounded so an endpoint that is refusing everything cannot storm the bus. */
  private deliveryGapsEmitted = 0;
  /** Every event lost to a failed send, including after the records are capped. */
  private deliveryDroppedEvents = 0;
  /** How many of `deliveryDroppedEvents` the emitted gap records already name. */
  private deliveryDroppedDeclared = 0;
  /**
   * Gaps recorded after teardown began. The bus drops events once `stopped` is
   * set, so a batch refused on the session's final flush would otherwise leave
   * no record of itself anywhere — the one moment the gap matters most.
   */
  private deferredDeliveryGaps: BugEvent[] = [];
  private baselineSampled: boolean;
  private sessionStarted = false;
  /**
   * Event batches handed to the transport whose POST has not yet settled.
   * stop() awaits these before ending the session: /api/session/end finalizes
   * the server's append log, and a batch that loses that race arrives after
   * finalization and vanishes. On a fast flow (an automated driver, a user
   * closing the tab right after the failing click) the losing batch is exactly
   * the one carrying the defect's interaction and request.
   */
  private pendingSends = new Set<Promise<void>>();
  private sessionMetadataWrite: Promise<void> = Promise.resolve();
  /** Resolves true only when the current session's start request was admitted. */
  private sessionAdmission: Promise<boolean> = Promise.resolve(true);
  /** Refuses new explicit screenshot uploads once direct shutdown starts. */
  private screenshotClosing = false;
  private stopped = false;
  private inert: boolean;
  private stopPromise?: Promise<{ sessionId: string }>;
  private identity: CrumbtrailIdentity = {};
  private applicationRelease: ApplicationReleaseIdentity;
  private sessionStore?: SessionStore;
  private lifecycleTimer?: ReturnType<typeof setTimeout>;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private durationDeadline?: number;
  private lifecycleClosePromise?: Promise<void>;
  private lifecycleCloseState?: {
    immediateEnd: boolean;
    deadline?: number;
    escalationPromise?: Promise<void>;
    escalate?: () => void;
  };
  private lifecycleClosing = false;
  private lifecycleSuspended = false;
  private lifecycleEndPromise?: Promise<void>;

  /**
   * Session replay, off until the server says a project asked for it.
   *
   * There is no local option to switch this on. Replay records the pages a
   * customer's own end users see, so the decision belongs to the customer's
   * project settings rather than to whoever wired the SDK in, and it arrives on
   * the same config poll as the kill switch.
   */
  private replayEnabled = false;
  private replayMasking: ReplayMasking = "inputs_masked";
  private replay: ReplayRecorder | undefined;

  private constructor(
    config: CrumbtrailConfig,
    bus: EventBus,
    transport: CrumbtrailTransport,
    ringBuffer: RingBuffer,
    sessionId: string,
    applicationRelease: ApplicationReleaseIdentity,
    sessionStore?: SessionStore,
    runtimeBinding?: RuntimeBindingClient,
    inert = false,
  ) {
    this.config = config;
    this.inert = inert;
    this.localCaptureFloor = readLocalCaptureFloor(config);
    this.bus = bus;
    this.transport = transport;
    this.ringBuffer = ringBuffer;
    this.sessionId = sessionId;
    this.applicationRelease = applicationRelease;
    this.sessionStore = sessionStore;
    this.runtimeBinding = runtimeBinding;
    this.applicationExpectations = createApplicationExpectationManager({
      sessionId,
      emit: (event) => this.bus.emit(event),
    });
    this.remotePolicyReady = !remoteConfigProjectKey(config);
    const gpcSuppressed = Boolean(
      config.respectGpc && hasGlobalPrivacyControl(),
    );
    if (gpcSuppressed) warnGpcSuppressedCapture();
    this.consentGranted = config.consentMode === "implicit" && !gpcSuppressed;
    this.samplingShed = !isSampled(config.captureSampleRate);
    this.baselineSampled =
      !this.samplingShed && isSampled(config.baselineSampleRate);
    this.updateFlightRecorderState();
  }

  static init(
    presetOrConfig?: CrumbtrailPreset | Partial<CrumbtrailConfig>,
  ): Crumbtrail {
    const overrides =
      typeof presetOrConfig === "string"
        ? PRESETS[presetOrConfig]
        : presetOrConfig;
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      ...overrides,
      maskAllText: true,
      maskAllInputs: true,
    };
    const applicationRelease = readApplicationReleaseIdentity(config.release);

    // Before any collector can emit: the URL and masking paths read this list
    // from module scope rather than from config, because they are reached from
    // places that never see a config object.
    setRedactionKeepFields(config.redaction?.keepFields ?? []);
    setCaptureInputValues(config.redaction?.captureInputValues);

    // Non-browser guard (SSR, `next build`). init() is documented as a
    // module-scope call, so it runs during server render/build where `window`
    // is undefined. The collectors below bind `window.addEventListener` and
    // would throw `ReferenceError: window is not defined`, failing the host
    // build through no fault of the caller. Instead return an inert instance:
    // no collectors, no event loop, no network, no session POST. Every public
    // method already guards `window`/`document`, so isomorphic code can call
    // init()/flagBug() unconditionally and full capture kicks in when the same
    // bundle later runs in a real browser.
    //
    // A caller that supplies its own `transportInstance` is opting into
    // deliberate programmatic use (server-side clients, tests) and is exempt —
    // that path never touches `window` unless it also enables a window-binding
    // collector, which is then the caller's explicit choice.
    if (typeof window === "undefined" && !config.transportInstance) {
      return new Crumbtrail(
        config,
        new EventBus(),
        INERT_TRANSPORT,
        new RingBuffer(config.ringBufferMs, config.ringBufferMaxEvents),
        config.sessionId ?? generateSessionId(),
        applicationRelease,
        undefined,
        undefined,
        true,
      );
    }

    const sessionStore =
      config.sessionPersistence === "session"
        ? (config.sessionStore ?? createWebSessionStore())
        : undefined;
    const useSessionStore = Boolean(sessionStore);
    // Reuse a persisted session id across a hard page reload (same tab, within the idle window)
    // so a reload appends to the same session instead of spawning a new one. SSR / non-browser
    // falls through to a fresh id.
    //
    // `crumbtrail-core/early` sits between those two: it already stamped a session id on the
    // requests that beat init to the wire, so adopting it keeps those requests, everything
    // captured after init, and the backend events carrying that header in ONE session. Early
    // capture reads the same persisted session first, so the two agree whenever a persisted
    // session exists. Once an early request is on the wire its session header cannot be changed,
    // so that id also has to win over an explicit `sessionId`; otherwise the browser finalizes
    // one session while the correlated backend and database events remain orphaned in another.
    const persistedSession = sessionStore
      ? readPersistedSessionId(sessionStore, config.sessionIdleMs)
      : undefined;
    const sessionId =
      readEarlySessionId() ??
      config.sessionId ??
      persistedSession?.id ??
      generateSessionId();
    const persistedAssertionCount =
      persistedSession?.id === sessionId
        ? persistedSession.applicationAssertionCount
        : 0;
    const persistedResponseAssertionCount =
      persistedSession?.id === sessionId
        ? persistedSession.applicationResponseAssertionCount
        : 0;
    const persistedExpectationCount =
      persistedSession?.id === sessionId
        ? persistedSession.applicationExpectationCount
        : 0;
    if (sessionStore)
      writePersistedSession(
        sessionStore,
        sessionId,
        persistedAssertionCount,
        persistedResponseAssertionCount,
        persistedExpectationCount,
      );

    // Nowhere to send: same inert shape as the non-browser guard above, and for
    // the same reason. A capture SDK that throws inside a host app's module
    // scope takes the page with it, so a missing endpoint reports itself and
    // stops rather than raising. It sits after the session id is resolved so an
    // inert instance still answers with the session a previous launch persisted:
    // isomorphic and cross launch correlation code reads that id whether or not
    // capture is on. A caller supplying its own transport is exempt, having
    // already said where events go.
    if (!config.transportInstance && config.httpEndpoint.trim() === "") {
      reportMissingEndpoint();
      return new Crumbtrail(
        config,
        new EventBus(),
        INERT_TRANSPORT,
        new RingBuffer(config.ringBufferMs, config.ringBufferMaxEvents),
        sessionId,
        applicationRelease,
        sessionStore,
        undefined,
        true,
      );
    }

    const bus = new EventBus();
    const ringBuffer = new RingBuffer(
      config.ringBufferMs,
      config.ringBufferMaxEvents,
    );

    const runtimeBinding = config.transportInstance
      ? undefined
      : createRuntimeBindingClient({
          endpoint: config.httpEndpoint,
          projectKey: config.httpAuthToken,
        });
    const transport: CrumbtrailTransport =
      config.transportInstance ??
      new HttpTransport(config.httpEndpoint, {
        authToken: config.httpAuthToken,
        ...(runtimeBinding ? { runtimeBinding } : {}),
      });

    const instance = new Crumbtrail(
      config,
      bus,
      transport,
      ringBuffer,
      sessionId,
      applicationRelease,
      sessionStore,
      runtimeBinding,
    );
    instance.applicationAssertions = persistedAssertionCount;
    instance.applicationResponseAssertions = persistedResponseAssertionCount;
    instance.applicationExpectations = createApplicationExpectationManager({
      sessionId,
      admittedCount: persistedExpectationCount,
      emit: (event) => instance.bus.emit(event),
    });

    // Send events to transport. Flight recorder sessions deliberately keep pre-trigger events
    // local; capture gap records remain visible so sampling never fails silently.
    bus.subscribe((events) => {
      const persistable = events.filter((event) =>
        instance.shouldPersistEvent(event),
      );
      if (persistable.length > 0) {
        const batches = new Map<string, BugEvent[]>();
        for (const event of persistable) {
          const origin =
            config.maxSessionDurationMs > 0 &&
            typeof event.d.sessionId === "string"
              ? event.d.sessionId
              : instance.sessionId;
          const batch = batches.get(origin) ?? [];
          batch.push(event);
          batches.set(origin, batch);
        }
        const send = Promise.all(
          [...batches].map(([id, batch]) =>
            (config.maxSessionDurationMs > 0 && transport.sendSessionEvents
              ? transport.sendSessionEvents(id, batch)
              : transport.sendEvents(batch)
            ).catch((error: unknown) =>
              instance.recordDeliveryFailure(batch, error),
            ),
          ),
        ).then(() => undefined);
        instance.pendingSends.add(send);
        void send.then(() => instance.pendingSends.delete(send));
      }
    });

    // Feed events into ring buffer
    bus.subscribe((events) => {
      ringBuffer.pushBatch(events);
    });

    // Refresh the persisted session's lastActivity as events flow, so an active session keeps
    // its rolling idle window alive across reloads.
    if (useSessionStore && sessionStore) {
      bus.subscribe(() => {
        writePersistedSession(
          sessionStore,
          instance.sessionId,
          instance.applicationAssertions,
          instance.applicationResponseAssertions,
          instance.applicationExpectations.admittedCount,
        );
      });
    }

    bus.setMaxBufferedEvents(config.ringBufferMaxEvents);
    bus.start(config.flushIntervalMs, config.flushBufferSize);

    bus.setAdmissionPredicate((event, context) =>
      instance.shouldAdmitEvent(event, context),
    );

    // Severity flush: error-class events must not wait out the batch interval —
    // an error captured in the final seconds before tab close would otherwise
    // be lost. Taps run BEFORE the event is buffered (EventBus.emit), so the
    // flush is deferred a microtask to guarantee the triggering event is part
    // of the shipped batch. Rate-limited (SEVERITY_FLUSH_MIN_INTERVAL_MS) so a
    // storm collapses into one early flush and stragglers ride the next
    // interval flush. `bug.flag` is excluded: flagBug() already flushes.
    let lastSeverityFlushAt = Number.NEGATIVE_INFINITY;
    let severityFlushPending = false;
    instance.cleanups.push(
      bus.tap((event) => {
        if (severityFlushPending) return;
        if (!isSevereEvent(event)) return;
        if (now() - lastSeverityFlushAt < SEVERITY_FLUSH_MIN_INTERVAL_MS)
          return;
        lastSeverityFlushAt = now();
        severityFlushPending = true;
        queueMicrotask(() => {
          severityFlushPending = false;
          bus.flush();
        });
      }),
    );

    // Last-chance flush and close on page lifecycle changes. `pagehide` is the
    // most reliable end-of-life signal across browsers (tab close and
    // navigation), while `visibilitychange` covers mobile backgrounding where
    // pagehide may never arrive. The transport's keepalive/sendBeacon path then
    // gives the final batch and end request a real chance to leave the page.
    // Guarded because a caller-supplied `transportInstance` lets init() run
    // without a window (SSR/programmatic).
    //
    // `window` existing is not enough to conclude there is an event target
    // behind it. React Native's `setUpGlobals` does `global.window = global`,
    // so RN passes a `typeof window` check while carrying no
    // `addEventListener` at all — an unguarded call here is a TypeError thrown
    // out of init() on the first launch of every RN app.
    if (
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      const cancelLifecycleTimer = () => instance.cancelLifecycleTimer();
      const onPageHide = (event: Event & { persisted?: boolean }) => {
        // A persisted pagehide means the document is entering the back forward
        // cache. Keep that visit open: closing it here would discard the rest
        // of the visit when the page is restored. The pending visibility timer
        // is cancelled before the page is frozen.
        if (event.persisted) {
          cancelLifecycleTimer();
          bus.flush();
          return;
        }
        if (config.endOnPageHide === false) {
          bus.flush();
          return;
        }
        // Defer the keepalive end request until already admitted sends settle. A real navigation
        // may terminate this task first, in which case the server's session TTL finalizes it.
        void instance.closeForLifecycle(true);
      };
      const onPageShow = (event: Event & { persisted?: boolean }) => {
        if (event.persisted) void instance.resumeFromLifecycle();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          if (config.endOnPageHide !== false) instance.scheduleLifecycleClose();
          return;
        }
        cancelLifecycleTimer();
        void instance.resumeFromLifecycle();
      };
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      if (
        typeof document !== "undefined" &&
        typeof document.addEventListener === "function"
      ) {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
      instance.cleanups.push(() => {
        cancelLifecycleTimer();
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
        if (
          typeof document !== "undefined" &&
          typeof document.removeEventListener === "function"
        ) {
          document.removeEventListener("visibilitychange", onVisibilityChange);
        }
      });
    }

    const collectorContext: CollectorContext = {
      get sessionId() {
        return instance.sessionId;
      },
      getDeclaredEnv: () => ({
        flags: instance.declaredFlags,
        config: instance.declaredConfig,
      }),
      onEnvEmitted: () => {
        instance.envEmitted = true;
      },
      registerStateProvider: (name, provider) =>
        instance.registerStateProvider(name, provider),
      whenCaptureAdmitted: (settle) => instance.whenCaptureAdmitted(settle),
      registerStorageFailureSync: (sync) => {
        instance.storageFailureSyncs.add(sync);
        return () => instance.storageFailureSyncs.delete(sync);
      },
    };

    instance.collectorContext = collectorContext;

    instance.configureAutoFlagController();
    instance.startSessionIfAllowed();
    instance.emitSamplingGapIfNeeded();

    for (const key of Object.keys(COLLECTOR_MAP)) {
      if (config[key as keyof CrumbtrailConfig]) instance.installCollector(key);
    }

    // Mount widget if enabled
    if (config.widget && typeof document !== "undefined") {
      import("./widget/bug-widget")
        .then(({ mountWidget }) => {
          instance.widgetCleanup = mountWidget(instance);
        })
        .catch(() => {});
    }

    const remoteConfigKey = remoteConfigProjectKey(config);
    if (remoteConfigKey) {
      instance.startConfigPolling({
        endpoint: captureConfigEndpoint(config),
        projectKey: remoteConfigKey,
        intervalMs: config.configPollIntervalMs,
        ...(runtimeBinding ? { runtimeBinding } : {}),
      });
    }

    return instance;
  }

  async flagBug(options?: FlagBugOptions): Promise<{ bugId: string }> {
    // Provenance is the SDK's to state, never the caller's: anything reaching the public
    // entry point is a person asking for a report, so the internal fields are stripped
    // rather than trusted.
    const {
      origin: _origin,
      autoReason: _autoReason,
      ...caller
    } = (options ?? {}) as InternalFlagOptions;
    const { bugId } = await this.flagBugFromSource(
      options === undefined ? undefined : caller,
      true,
    );
    return { bugId };
  }

  /**
   * Upload one user supplied PNG artifact for the active session.
   *
   * This method accepts an already available Blob or an application owned
   * canvas. It never requests display media and never captures on its own.
   * The generated name is the only path the caller can associate with a bug.
   */
  async captureScreenshot(
    source: Blob | HTMLCanvasElement,
    options?: CaptureScreenshotOptions,
  ): Promise<{ artifactName: string }> {
    if (!this.sessionStarted || !this.canTransport() || this.screenshotClosing)
      throw new Error("captureScreenshot requires an active session");
    if (!this.config.reportScreenshotsEnabled)
      throw new Error("captureScreenshot is not enabled by the project policy");

    // Bind the complete operation to the session that admitted it. Register the pending promise
    // before the first await so stop() and lifecycle rollover cannot finalize the session while
    // this upload is still in flight.
    const capturedSessionId = this.sessionId;
    const upload = (async () => {
      const admitted = await this.sessionAdmission;
      if (!admitted || !this.isScreenshotSessionActive(capturedSessionId))
        throw new Error("captureScreenshot requires an active session");

      const blob = await prepareReportScreenshot(source, options);
      if (!this.isScreenshotSessionActive(capturedSessionId))
        throw new Error("captureScreenshot requires an active session");
      const artifactName = generateReportScreenshotArtifactName();
      await this.transport.sendBlob(
        artifactName,
        blob,
        undefined,
        capturedSessionId,
      );
      // A custom transport may not enforce the optional session binding itself. Never make an
      // artifact eligible for association after the SDK observes a rollover or shutdown.
      if (!this.isScreenshotSessionActive(capturedSessionId))
        throw new Error("captureScreenshot requires an active session");
      this.visualArtifactNames.add(artifactName);
      return { artifactName };
    })();
    const pending = upload.then(
      () => undefined,
      () => undefined,
    );
    this.pendingSends.add(pending);
    void pending.then(() => this.pendingSends.delete(pending));
    return upload;
  }

  private async flagBugFromSource(
    options: InternalFlagOptions | undefined,
    isExplicitBeacon: boolean,
  ): Promise<FlagOutcome> {
    if (isExplicitBeacon && !this.config.explicitBeacon)
      return { bugId: this.createBugId(), captured: false };
    if (!this.canCapture())
      return { bugId: this.createBugId(), captured: false };

    if (this.config.flightRecorder) {
      if (this.flightRecorderFinalization)
        return this.flightRecorderFinalization;
      this.updateFlightRecorderState();
      if (this.flightRecorderState === "buffering")
        return this.triggerFlightRecorder(options);
      if (this.flightRecorderState === "finalizing")
        return { bugId: this.createBugId(), captured: false };
    }

    return this.finalizeFlagBug(options);
  }

  /** Alias for production beacons and support integrations. */
  async flag(options?: FlagBugOptions): Promise<{ bugId: string }> {
    return this.flagBug(options);
  }

  private async finalizeFlagBug(
    options?: InternalFlagOptions,
    finalizerOriginated = false,
  ): Promise<FlagOutcome> {
    const bugId = this.createBugId();
    const windowMs = options?.windowMs ?? this.config.ringBufferMs;
    const flaggedAt = now();
    const origin: BugFlagOrigin = options?.origin ?? "user";
    // A note exists only when a person wrote one. An automatic capture used to borrow the
    // note field for the detector's own sentence, which then went through `maskText` like
    // user text — so a session with no flag button and nobody typing produced a report
    // reading "a note was attached, and its text was masked before capture". Neither half
    // was true. The detector's sentence rides in `reason` instead, unmasked because the
    // SDK wrote it and it contains nothing a person entered.
    const note =
      origin === "user" && options?.note !== undefined
        ? maskText(options.note)
        : undefined;
    const reason =
      origin === "auto" && typeof options?.autoReason === "string"
        ? options.autoReason
        : undefined;
    const visualArtifactName =
      typeof options?.visualArtifactName === "string" &&
      isReportScreenshotArtifactName(options.visualArtifactName) &&
      this.visualArtifactNames.has(options.visualArtifactName)
        ? options.visualArtifactName
        : undefined;

    // Resolved flag/config state at flag time. The session-start snapshot plus deltas answers
    // "what were the flags at t0"; only this answers "what were they at the moment this broke",
    // without a reader replaying every delta by hand. Emitted at `flaggedAt` so it lands in the
    // same window as the evidence it explains. Nothing declared means nothing emitted: an empty
    // snapshot is noise, and noise in a bundle costs a reader attention.
    //
    // Gated on `envEmitted` for the same reason `setEnv` is: with the environment collector
    // disabled the session carries no `k:'env'` event at all, and a flag snapshot appearing
    // where the app switched env capture off would contradict that configuration.
    if (
      this.envEmitted &&
      (Object.keys(this.declaredFlags).length > 0 ||
        Object.keys(this.declaredConfig).length > 0)
    ) {
      // `buildEnvDelta` is the one place flags/config go through `redactValue` under the
      // `env.flags`/`env.config` paths; reusing it keeps the snapshot on the same policy as
      // the snapshot and delta rather than growing a second redaction path that can drift.
      const flagSnapshot = buildEnvDelta(
        this.declaredFlags,
        this.declaredConfig,
        {
          diagnosticFields: this.config.redaction?.diagnosticFields,
          denyFields: this.config.redaction?.denyFields,
        },
      );
      flagSnapshot.kind = "flag-snapshot";
      this.bus.emit(
        {
          t: flaggedAt,
          k: "env",
          d: flagSnapshot as unknown as Record<string, unknown>,
        },
        // Without this the flight recorder finalization path drops the event, so the feature
        // would work in the ordinary case and vanish in exactly the case it was built for.
        { bypassAdmission: finalizerOriginated },
      );
    }

    // Capture provider state snapshots at flag time so they land in the same window.
    const stateProviderNames = Array.from(this.stateProviders.keys());
    for (const [name, provider] of this.stateProviders) {
      try {
        const rawValue = provider();
        const state = this.config.captureRawState
          ? { value: rawValue, metadata: undefined }
          : redactValue(rawValue, `state.${name}`);
        const value = state.value;
        const json = JSON.stringify(value);
        const truncated =
          json.length > this.config.stateMaxBytes
            ? `${json.slice(0, this.config.stateMaxBytes)}...`
            : json;
        const d: Record<string, unknown> = {
          name,
          json: truncated,
          truncated: truncated !== json,
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, state.metadata);
        this.bus.emit(
          {
            t: flaggedAt,
            k: "state.snap",
            d,
          },
          { bypassAdmission: finalizerOriginated },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const redactedMsg = this.config.captureRawState
          ? { body: msg, metadata: undefined }
          : redactNetworkTextBody(msg, {
              contentType: "text/plain",
              path: "msg",
            });
        const d: Record<string, unknown> = {
          name,
          msg: redactedMsg.body ?? bodyPlaceholder(redactedMsg.bodySummary),
          ...(redactedMsg.bodySummary
            ? { msgSummary: redactedMsg.bodySummary }
            : {}),
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, redactedMsg.metadata);
        this.bus.emit(
          {
            t: flaggedAt,
            k: "state.err",
            d,
          },
          { bypassAdmission: finalizerOriginated },
        );
      }
    }

    // One-shot DOM snapshot: the exact UI at flag time, which the event stream can't reconstruct.
    if (this.config.domSnapshot && typeof document !== "undefined") {
      try {
        const fullHtml = buildMaskedDomSnapshot(
          document.documentElement,
          this.config,
        );
        // Truncate before redacting: redactNetworkTextBody's maxLength summarizes the whole
        // body away, but a clipped DOM is still useful evidence.
        const clipped = fullHtml.slice(0, this.config.domSnapshotMaxBytes);
        const redacted = this.config.captureRawState
          ? { body: clipped, metadata: undefined }
          : redactNetworkTextBody(clipped, {
              contentType: "text/html",
              path: "dom",
            });
        const d: Record<string, unknown> = {
          html: redacted.body ?? clipped,
          truncated: clipped.length !== fullHtml.length,
          bytes: fullHtml.length,
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, redacted.metadata);
        this.bus.emit(
          { t: flaggedAt, k: "dom.snap", d },
          { bypassAdmission: finalizerOriginated },
        );
      } catch {
        // DOM serialization must never block the report.
      }
    }

    // Emit marker into the live stream and include it in snapshot.
    this.bus.emit(
      {
        t: flaggedAt,
        k: "bug.flag",
        d: {
          bugId,
          origin,
          ...(note !== undefined ? { note } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(visualArtifactName !== undefined ? { visualArtifactName } : {}),
        },
      },
      { bypassAdmission: finalizerOriginated },
    );

    // Flush pending events into ring buffer before snapshot
    this.bus.flush();

    const events = this.ringBuffer.snapshot(windowMs);

    // Compute summary stats from snapshot
    const errorCount = events.filter(
      (e) => e.k === "err" || e.k === "rej",
    ).length;
    const failedRequestCount = events.filter((e) =>
      isFailedNetworkResponse(e),
    ).length;
    const eventKinds: Record<string, number> = {};
    for (const e of events) {
      eventKinds[e.k] = (eventKinds[e.k] || 0) + 1;
    }
    const durationMs =
      events.length >= 2 ? events[events.length - 1].t - events[0].t : 0;

    const report: BugReport = {
      bugId,
      sessionId: this.sessionId,
      flaggedAt,
      windowMs,
      note,
      voiceNote: options?.voiceBlob ? "voice.webm" : undefined,
      url: currentPageUrl(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      ...this.identity,
      tags: options?.tags,
      summary: {
        errorCount,
        failedRequestCount,
        eventCount: events.length,
        eventKinds,
        durationMs,
        stateProviderCount: stateProviderNames.length,
      },
    };

    // Send to server
    await this.transport.sendBugReport(report, events, options?.voiceBlob);

    return { bugId, captured: true };
  }

  consent(granted: boolean): void {
    this.explicitConsent = granted;
    this.consentGranted = granted;
    if (!granted) {
      this.bus.clear();
      this.ringBuffer.clear();
      this.abortFlightRecorder();
      this.updateFlightRecorderState();
      this.settleAdmissionWaiters();
      return;
    }
    this.updateFlightRecorderState();
    this.startSessionIfAllowed();
    this.settleAdmissionWaiters();
    this.emitSamplingGapIfNeeded();
  }

  identify(identity: CrumbtrailIdentity): void {
    const accountId = pseudonymousId(identity.accountId);
    const userId = pseudonymousId(identity.userId);
    let changed = false;
    if (accountId && this.identity.accountId !== accountId) {
      this.identity.accountId = accountId;
      changed = true;
    }
    if (userId && this.identity.userId !== userId) {
      this.identity.userId = userId;
      changed = true;
    }
    if (changed && this.sessionStarted) this.refreshSessionIdentity();
  }

  startConfigPolling(
    options: CaptureConfigPollingOptions & {
      runtimeBinding?: RuntimeBindingClient;
    },
  ): () => void {
    this.stopConfigPolling();
    this.remotePolicyReady = false;
    this.updateFlightRecorderState();
    this.clearRemotePolicyTimer();
    this.remotePolicyTimer = setTimeout(
      () => this.applyRemotePolicyFallback(),
      REMOTE_POLICY_TIMEOUT_MS,
    );
    const intervalMs = normalizeInterval(options.intervalMs);
    let stopped = false;

    const poll = async () => {
      if (stopped || typeof fetch !== "function") return;
      const generation = ++this.configPollGeneration;
      try {
        let binding: RuntimeBinding | undefined;
        if (
          options.runtimeBinding?.matchesOrigin(options.endpoint) &&
          !stopped &&
          generation === this.configPollGeneration
        )
          binding = await options.runtimeBinding.getBinding();
        if (stopped || generation !== this.configPollGeneration) return;
        // `no-store`: the config route answers with `Cache-Control: private, max-age=60` and the
        // default poll interval is exactly that, so an HTTP cache hit would replay the previous
        // body. A replayed body re-runs whatever probe it asked for and rests a second copy of the
        // answer, which for `storage.snapshot` is a duplicate payload out of a live application.
        const response = await fetch(configPollingUrl(options, binding), {
          method: "GET",
          cache: "no-store",
          ...(binding
            ? { headers: { Authorization: `Bearer ${binding.instanceProof}` } }
            : {}),
        });
        if (!response.ok && response.status >= 400) {
          // A revoked proof must not keep authorizing targeted work on later
          // polls. Clear only the binding, preserving the legacy fallback and
          // allowing the next poll to register a fresh identity.
          if (response.status === 401 && binding)
            options.runtimeBinding?.invalidate();
          return;
        }
        const payload: unknown = await response.json();
        if (stopped || generation !== this.configPollGeneration) return;
        const settings = readRemotePolicySettings(payload);
        if (settings) {
          this.applyRemoteConfig(settings);
          this.remotePolicyReady = true;
          this.clearRemotePolicyTimer();
        }
        this.updateFlightRecorderState();
        this.startSessionIfAllowed();
        this.settleAdmissionWaiters();
        this.emitSamplingGapIfNeeded();
        // Probes run after the policy is live, not during it: a probe result is an event, and an
        // event emitted while `remotePolicyReady` is still false is dropped by the admission
        // predicate before it reaches the bus.
        if (settings)
          await this.runRemoteProbes(
            settings,
            generation,
            binding !== undefined,
          );
      } catch {
        // Retain the last known policy when the config service is unavailable.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Bumping the generation here, rather than in `stopConfigPolling`, is what makes the
      // disposer handed to the caller interrupt a probe run that is already mid loop: the loop
      // guards on the generation, and `stopped` above is a local of this closure that the loop
      // cannot see. Without it a stop only prevents the next poll, while up to four probes keep
      // running and resting events after the host asked polling to stop.
      this.configPollGeneration += 1;
      if (this.configPollingCleanup === stop)
        this.configPollingCleanup = undefined;
    };
    this.configPollingCleanup = stop;
    return stop;
  }

  private stopConfigPolling(): void {
    // The generation bump lives in the disposer itself, which this delegates to.
    this.configPollingCleanup?.();
    this.configPollingCleanup = undefined;
  }

  private applyRemoteConfig(settings: Record<string, unknown>): void {
    const oldSampleRate = this.config.captureSampleRate;
    const oldBaselineSampleRate = this.config.baselineSampleRate;
    let shouldReconfigureAutoFlag = false;

    for (const key of REMOTE_CONFIG_KEYS) {
      const value = settings[key];
      if (!isRemoteConfigValue(key, value)) continue;
      if (this.config[key] !== value) {
        Object.assign(this.config, { [key]: value });
        shouldReconfigureAutoFlag ||= isTriggerConfigKey(key);
      }
    }

    applyRemoteMaskingMode(this.config, settings);
    shouldReconfigureAutoFlag ||= applyRemoteTriggerSwitches(
      this.config,
      settings,
    );
    applyRemoteSampling(this.config, settings);
    applyRemoteTailDuration(this.config, settings);
    applyRemoteConsentMode(this.config, settings);
    // Limits before switches: a collector started on this poll reads the config at install, so
    // the values it runs with have to be the ones the poll just carried.
    applyRemoteNetworkLimits(this.config, settings, this.localCaptureFloor);
    applyRemoteRedaction(this.config, settings, this.localCaptureFloor);
    applyRemoteSizeLimits(this.config, settings, this.localCaptureFloor);
    this.remoteCollectorChanges = applyRemoteCollectorSwitches(
      this.config,
      settings,
      this.localCaptureFloor,
    );
    this.applyRemoteCollectorChanges();
    for (const sync of this.storageFailureSyncs) sync();

    if (typeof settings.killSwitch === "boolean") {
      const changed = this.killSwitch !== settings.killSwitch;
      this.killSwitch = settings.killSwitch;
      if (changed && this.killSwitch) {
        this.bus.clear();
        this.ringBuffer.clear();
        this.abortFlightRecorder();
        this.settleAdmissionWaiters();
      }
    }

    if (typeof settings.replayEnabled === "boolean")
      this.replayEnabled = settings.replayEnabled;
    if (
      settings.replayMasking === "inputs_masked" ||
      settings.replayMasking === "text_masked"
    )
      this.replayMasking = settings.replayMasking;

    this.applyRemoteRingBufferBounds(settings);

    if (
      oldSampleRate !== this.config.captureSampleRate ||
      oldBaselineSampleRate !== this.config.baselineSampleRate
    )
      this.resampleSession();
    this.applyConsentPolicy();
    this.updateFlightRecorderState();
    this.updateReplayState();
    if (shouldReconfigureAutoFlag) this.configureAutoFlagController();
    this.startSessionIfAllowed();
    this.emitSamplingGapIfNeeded();
    if (
      hasRemoteCaptureTrigger(settings) &&
      this.config.flightRecorder &&
      this.canCapture()
    )
      void this.flag({ tags: ["config:trigger"] });
  }

  /**
   * Apply the ring buffer bounds a policy carries.
   *
   * Tighten-only against the init values: retention is memory the application budgeted for, so a
   * policy may ask for less of it and never for more. Both bounds are validated here rather than
   * left to the buffer, because `RingBuffer` and `EventBus` hold two ceilings on the same events
   * and a value only one of them accepts leaves the pair disagreeing. An invalid value is
   * refused, not coerced.
   *
   * Retention is the window a flagged bug is cut from, so a lowered bound has to reach the live
   * buffer rather than the next session's: `setBounds` evicts on the spot, which is the point.
   * The events it drops are gone from the report that would have carried them, so the eviction
   * rests a `capture_gap` counting them — the same account a bus overflow gives.
   */
  private applyRemoteRingBufferBounds(settings: Record<string, unknown>): void {
    const floor = this.localCaptureFloor;
    const oldMs = this.config.ringBufferMs;
    const oldMaxEvents = this.config.ringBufferMaxEvents;

    const maxMs = readRemoteRingBufferMs(settings.ringBufferMs);
    if (maxMs !== undefined)
      this.config.ringBufferMs = Math.min(maxMs, floor.ringBufferMs);
    const maxEvents = readRemoteRingBufferMaxEvents(
      settings.ringBufferMaxEvents,
    );
    if (maxEvents !== undefined)
      this.config.ringBufferMaxEvents = Math.min(
        maxEvents,
        floor.ringBufferMaxEvents,
      );

    if (
      oldMs === this.config.ringBufferMs &&
      oldMaxEvents === this.config.ringBufferMaxEvents
    )
      return;

    const evicted = this.ringBuffer.setBounds({
      maxMs: this.config.ringBufferMs,
      maxEvents: this.config.ringBufferMaxEvents,
    });
    this.bus.setMaxBufferedEvents(this.config.ringBufferMaxEvents);
    if (evicted === 0) return;
    this.bus.emit(
      buildCaptureGapEvent({
        surface: "browser",
        reason: "retention_reduced",
        droppedEventCount: evicted,
        sessionId: this.sessionId,
      }),
    );
  }

  /**
   * Install one {@link COLLECTOR_MAP} collector and keep its teardown.
   *
   * Idempotent: a collector already installed is left alone rather than patched a second time.
   * That is what keeps a policy that flips a switch on every poll — or an integrator toggling by
   * hand — from stacking listeners, prototype patches and timers one copy per poll.
   *
   * A collector whose teardown once threw is refused outright for the rest of the session — see
   * {@link Crumbtrail.poisonedCollectors}.
   *
   * Install failures are not caught here: at init a collector that cannot install is the same
   * error it has always been. The mid-session caller guards its own call, because a poll must
   * not take the session down over one collector.
   */
  private installCollector(key: string): void {
    if (this.collectorTeardowns.has(key)) return;
    if (this.poisonedCollectors.has(key)) return;
    const collector = COLLECTOR_MAP[key];
    const context = this.collectorContext;
    if (!collector || !context) return;
    this.collectorTeardowns.set(key, collector(this.bus, this.config, context));
  }

  /**
   * Stop one collector and drop its teardown. Already-buffered events are untouched: the switch
   * says what to capture from here, not what to forget.
   */
  private teardownCollector(key: string): unknown | undefined {
    const teardown = this.collectorTeardowns.get(key);
    if (!teardown) return undefined;
    // Deleted before the call so a teardown that throws still leaves the collector gone from
    // the registry; otherwise `stop()` would run the same failing teardown a second time.
    this.collectorTeardowns.delete(key);
    try {
      teardown();
    } catch (error) {
      // One collector failing to tear down must not take the rest of the poll with it, the same
      // reasoning the shutdown loop runs on. The throw is still recorded: the collector is now
      // in an unknown state, so a later ON switch must not install a second copy over the half
      // that survived. See `poisonedCollectors`.
      this.poisonedCollectors.add(key);
      return error;
    }
    return undefined;
  }

  /**
   * Start and stop collectors for the switches the last poll moved.
   *
   * OFF is live for every collector. ON is live for every collector outside
   * {@link OFF_ONLY_COLLECTORS} and deferred to the next page load for the ones in it — see that
   * set for which and why. `campaign` and `domSnapshot` have no collector of their own:
   * `domSnapshot` is read when a bug is flagged and so is already live, while `campaign` is
   * read by the environment snapshot, which a session emits once.
   */
  private applyRemoteCollectorChanges(): void {
    // Read, not drained: the field stays the record of what the last poll moved, which is what
    // `applyRemoteCollectorSwitches` rewrites on every poll anyway.
    const changed = this.remoteCollectorChanges;
    if (changed.length === 0 || this.stopped) return;
    for (const key of changed) {
      if (!(key in COLLECTOR_MAP)) continue;
      if (this.config[key] === true) {
        if (OFF_ONLY_COLLECTORS.has(key)) continue;
        try {
          this.installCollector(key);
        } catch {
          // A collector that refuses to start mid-session leaves the session as it was.
        }
        continue;
      }
      this.teardownCollector(key);
      // The environment collector's own teardown has nothing to undo — its work is one snapshot
      // at install. The lane it opens is `envEmitted`, which is what lets `setEnv` rest deltas
      // and a flag rest its snapshot, so clearing that here is what actually turns env capture
      // off. A later ON re-installs, re-emits the snapshot and sets it again.
      if (key === "environment") this.envEmitted = false;
    }
  }

  /**
   * Run the probes a config poll asked for and rest each answer as one event.
   *
   * The whole of what a server may say is a name from {@link PROBE_NAMES}. No value from the
   * payload is ever handed to a probe: `runProbe` takes the name and a context this instance
   * builds from its own state, so there is nothing a response body can put inside a probe.
   *
   * Serial, not concurrent. This is someone else's production application, and one probe at a
   * time bounds the peak cost to one probe's bounds rather than four probes' bounds.
   */
  private async runRemoteProbes(
    settings: Record<string, unknown>,
    generation: number,
    runtimeTargeted: boolean,
  ): Promise<void> {
    const names = readRemoteProbeNames(settings);
    if (names.length === 0) return;

    for (const name of names) {
      // `canTransport()` is the same predicate that admits an event, so a probe reads the end
      // user's application only in the states where its answer would be allowed to leave it.
      // That covers stop, the kill switch and remote policy readiness, and adds consent: under
      // `consentMode: "required"` with consent not yet given, no probe touches the visitor's
      // storage at all rather than reading it and dropping the result at the bus.
      //
      // Checked per probe because the loop awaits, so any of those can arrive mid run — including
      // consent being revoked — and a newer poll generation retires this run outright.
      if (!this.canTransport()) return;
      if (generation !== this.configPollGeneration) return;
      const context = this.probeContext();
      if (name === "runtime.cpu_profile")
        context.runtimeTargeted = runtimeTargeted;
      const result = await runProbe(name, context);
      if (!this.canTransport()) return;
      if (generation !== this.configPollGeneration) return;
      this.bus.emit({
        t: now(),
        k: PROBE_RESULT_EVENT_KIND,
        d: { ...result } as unknown as Record<string, unknown>,
      });
    }
  }

  /**
   * Everything a probe is allowed to read from this instance. Each supplier takes the probe's
   * deadline signal and refuses once it has fired, so an abandoned probe cannot pull a state
   * provider of the host application's after the answer has stopped being wanted.
   *
   * `getStorageAreas` is deliberately absent: `runProbe` falls back to the ambient
   * `localStorage` and `sessionStorage`, guarded, which is the correct source in a browser and
   * correctly reports `unavailable` outside one.
   */
  private probeContext(): ProbeContext {
    return {
      getDeclaredEnv: (signal) =>
        signal.aborted
          ? undefined
          : { flags: this.declaredFlags, config: this.declaredConfig },
      getState: (name, signal) => {
        if (signal.aborted) return undefined;
        const provider = this.stateProviders.get(name);
        return provider ? provider() : undefined;
      },
    };
  }

  private resampleSession(): void {
    const wasShed = this.samplingShed;
    this.samplingShed = !isSampled(this.config.captureSampleRate);
    this.baselineSampled =
      !this.samplingShed && isSampled(this.config.baselineSampleRate);
    if (!wasShed && this.samplingShed) {
      this.bus.clear();
      this.ringBuffer.clear();
      // The hold is the third place events rest, and it holds the first screen.
      // A visitor this policy just shed must not upload it.
      this.pendingAdmissionEvents = [];
      this.pendingAdmissionDropped = 0;
      this.pendingAdmissionBytes = 0;
      this.pendingAdmissionMasking = undefined;
      this.emitSamplingGapIfNeeded();
    }
  }

  private configureAutoFlagController(): void {
    this.autoFlagCleanup?.();
    this.autoFlagCleanup = undefined;

    const autoFlagDetectors: SignalDetector[] = [];
    let renderedErrorCleanup: CollectorCleanup | undefined;
    if (this.config.autoFlagOnError || this.config.flightRecorder)
      autoFlagDetectors.push(
        errorDetector({
          uncaughtError: this.config.autoFlagOnUncaughtError,
          unhandledRejection: this.config.autoFlagOnUnhandledRejection,
        }),
      );
    // Under the flight recorder a single failing response is enough to close a window: the
    // buffer already holds everything that led to it, so waiting for a second one only loses
    // the first. That used to be arranged by forcing the retry storm detector's fail threshold
    // to 1, which made lone-4xx capture a side effect of a DIFFERENT switch: a customer turning
    // "retry storm" off in the dashboard silently lost every 4xx capture too, with nothing on
    // the screen saying so. It is the request-status trigger's job, so it lives here and the
    // retry storm detector keeps the threshold the customer configured.
    if (this.config.autoFlagOnRequest5xx)
      autoFlagDetectors.push(
        requestFailureDetector({
          minStatus: this.config.flightRecorder ? 400 : 500,
        }),
      );
    if (this.config.autoFlagOnRenderedError || this.config.flightRecorder) {
      autoFlagDetectors.push(renderedErrorDetector());
      renderedErrorCleanup = renderedErrorCollector(this.bus);
    }
    // Reactive triggers read failures the application or browser has already
    // produced, so they do not depend on the behavioral signal group.
    if (this.config.autoFlagOnCaughtError)
      autoFlagDetectors.push(caughtErrorDetector());
    if (this.config.autoFlagOnResponseBodyError)
      autoFlagDetectors.push(responseBodyErrorDetector());
    if (this.config.autoFlagOnStreamFailure)
      autoFlagDetectors.push(streamFailureDetector());
    if (this.config.autoFlagOnWorkerError)
      autoFlagDetectors.push(workerErrorDetector());
    if (this.config.autoFlagOnWrongNumber)
      autoFlagDetectors.push(wrongNumberDetector());
    if (this.config.autoFlagOnResourceLoadFailure)
      autoFlagDetectors.push(resourceLoadFailureDetector());
    if (this.config.autoFlagOnStorageFailure)
      autoFlagDetectors.push(storageFailureDetector());
    if (this.config.autoFlagOnSignals || this.config.flightRecorder) {
      if (this.config.autoFlagOnRageClick)
        autoFlagDetectors.push(
          rageClickDetector({
            threshold: this.config.rageClickThreshold,
            windowMs: this.config.rageClickWindowMs,
          }),
        );
      if (this.config.autoFlagOnRetryStorm)
        autoFlagDetectors.push(
          retryStormDetector({
            threshold: this.config.retryStormThreshold,
            windowMs: this.config.retryStormWindowMs,
            failThreshold: this.config.retryStormFailThreshold,
          }),
        );
      if (this.config.autoFlagOnSlowResponse)
        autoFlagDetectors.push(
          slowResponseDetector({
            thresholdMs: this.config.slowRequestMs,
            count: this.config.slowRequestCount,
            windowMs: this.config.slowRequestWindowMs,
          }),
        );
      if (this.config.autoFlagOnAbandonedFlow)
        autoFlagDetectors.push(
          abandonedFlowDetector({
            windowMs: this.config.abandonedFlowWindowMs,
            minInputs: this.config.abandonedFlowMinInputs,
          }),
        );
    }
    if (autoFlagDetectors.length === 0) return;

    const autoFlag = createAutoFlagController({
      debounceMs: this.config.autoFlagDebounceMs,
      maxPerSession: this.config.autoFlagMaxPerSession,
      flag: (request) =>
        this.flagBugFromSource(
          { tags: request.tags, origin: "auto", autoReason: request.reason },
          false,
        ).then((outcome) => outcome.captured),
      detectors: autoFlagDetectors,
    });
    this.autoFlag = autoFlag;
    const detach = this.bus.tap((event) => autoFlag.handleEvent(event));
    this.autoFlagCleanup = () => {
      detach();
      autoFlag.dispose();
      renderedErrorCleanup?.();
      if (this.autoFlag === autoFlag) this.autoFlag = undefined;
    };
  }

  private triggerFlightRecorder(
    options?: InternalFlagOptions,
  ): Promise<FlagOutcome> {
    this.flightRecorderState = "triggered";
    this.startSessionIfAllowed();
    // Move every pre-trigger event from the bus batch into the flight recorder before tailing.
    this.bus.flush();
    const tailMs = Math.max(0, this.config.flightRecorderTailMs);
    if (tailMs === 0) {
      return this.trackFlightRecorderFinalization(
        this.finalizeFlightRecorder(options),
      );
    }

    this.flightRecorderState = "tailing";
    return this.trackFlightRecorderFinalization(
      new Promise((resolve, reject) => {
        this.flightRecorderTailResolver = resolve;
        this.flightRecorderTimer = setTimeout(() => {
          this.flightRecorderTimer = undefined;
          this.flightRecorderTailResolver = undefined;
          if (!this.canCapture()) {
            resolve({ bugId: this.createBugId(), captured: false });
            return;
          }
          this.finalizeFlightRecorder(options).then(resolve, reject);
        }, tailMs);
      }),
    );
  }

  private async finalizeFlightRecorder(
    options?: InternalFlagOptions,
  ): Promise<FlagOutcome> {
    this.flightRecorderState = "finalizing";
    return this.finalizeFlagBug(options, true);
  }

  private trackFlightRecorderFinalization(
    finalization: Promise<FlagOutcome>,
  ): Promise<FlagOutcome> {
    this.flightRecorderFinalization = finalization;
    const complete = () => {
      this.flightRecorderTimer = undefined;
      this.flightRecorderTailResolver = undefined;
      this.flightRecorderFinalization = undefined;
      // Finalization ends a WINDOW, not the session. Left "finalized", the
      // recorder refused every event for the rest of the instance's life — no
      // events, no ring buffer, and no gap record saying capture had stopped —
      // while the auto flag controller went on raising signals that could never
      // produce a report. The ring buffer is cleared because the next window
      // starts here, not because there will not be one.
      this.ringBuffer.clear();
      // The signal keys go with it. Dedup is per window, so a session that hits the same
      // fixed-key signal again — a second slow response episode, a second abandoned flow —
      // opens a second window instead of being swallowed by the first one's memory.
      this.autoFlag?.endWindow();
      this.flightRecorderState = this.canCapture() ? "buffering" : "armed";
    };
    void finalization.then(complete, complete);
    return finalization;
  }

  private abortFlightRecorder(): void {
    if (this.flightRecorderTimer) clearTimeout(this.flightRecorderTimer);
    this.flightRecorderTimer = undefined;
    const settle = this.flightRecorderTailResolver;
    this.flightRecorderTailResolver = undefined;
    if (settle) settle({ bugId: this.createBugId(), captured: false });
    if (!this.flightRecorderFinalization) this.updateFlightRecorderState();
  }

  private updateFlightRecorderState(): void {
    if (!this.config.flightRecorder) {
      this.flightRecorderState = "armed";
      return;
    }
    if (
      this.flightRecorderState === "triggered" ||
      this.flightRecorderState === "tailing" ||
      this.flightRecorderState === "finalizing"
    )
      return;
    this.flightRecorderState = this.canCapture() ? "buffering" : "armed";
  }

  private applyConsentPolicy(): void {
    const nextConsent =
      this.explicitConsent ??
      (this.config.consentMode === "implicit" &&
        !(this.config.respectGpc && hasGlobalPrivacyControl()));
    if (this.config.respectGpc && hasGlobalPrivacyControl())
      warnGpcSuppressedCapture();
    if (nextConsent === this.consentGranted) return;
    this.consentGranted = nextConsent;
    if (!nextConsent) {
      this.bus.clear();
      this.ringBuffer.clear();
      this.abortFlightRecorder();
    }
    this.settleAdmissionWaiters();
  }

  private startSessionWithCurrentIdentity(): void {
    const sessionId = this.sessionId;
    const attempt = this.sendSessionMetadata(sessionId);
    this.sessionAdmission = attempt.then(
      () => this.sessionId === sessionId,
      () => false,
    );
    this.sessionMetadataWrite = attempt.catch(() => {});
  }

  private refreshSessionIdentity(): void {
    this.sessionMetadataWrite = this.sessionMetadataWrite.then(() => {
      const sessionId = this.sessionId;
      const attempt = this.sendSessionMetadata(sessionId);
      this.sessionAdmission = attempt.then(
        () => this.sessionId === sessionId,
        () => false,
      );
      return attempt.catch(() => {});
    });
  }

  private sendSessionMetadata(sessionId: string): Promise<void> {
    try {
      return Promise.resolve(
        this.transport.startSession(sessionId, {
          url: currentPageUrl(),
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
          ...(this.config.service ? { service: this.config.service } : {}),
          ...this.applicationRelease,
          sdkVersion: CRUMBTRAIL_SDK_VERSION,
          ...this.identity,
        }),
      );
    } catch {
      return Promise.reject(new Error("session start failed"));
    }
  }

  private isScreenshotSessionActive(sessionId: string): boolean {
    return (
      this.sessionStarted && this.sessionId === sessionId && this.canTransport()
    );
  }

  private expirePersistedVisit(): void {
    if (!(this.config.maxSessionDurationMs > 0)) return;
    const store = this.sessionStore ?? createWebSessionStore();
    try {
      const persisted = store?.read();
      if (persisted?.id === this.sessionId)
        store?.write({ ...persisted, lastActivity: 0 });
    } catch {
      // Storage refusal must not prevent closing the visit.
    }
  }

  private cancelDurationTimer(): void {
    if (this.durationTimer !== undefined) clearTimeout(this.durationTimer);
    this.durationTimer = undefined;
  }

  private scheduleDurationRotation(): void {
    this.cancelDurationTimer();
    const duration = this.config.maxSessionDurationMs;
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !this.transport.sendSessionEvents ||
      this.config.flightRecorder
    )
      return;
    this.durationDeadline = Date.now() + duration;
    this.durationTimer = setTimeout(
      () => {
        this.durationTimer = undefined;
        this.rotateActiveSession();
      },
      Math.min(duration, 2_147_483_647),
    );
  }

  private rotateActiveSession(): void {
    if (!this.sessionStarted || !this.canTransport()) return;
    const previousId = this.sessionId;
    this.bus.flush();
    this.expirePersistedVisit();
    const pending = [...this.pendingSends, this.sessionMetadataWrite];
    const replay = this.replay;
    this.replay = undefined;
    if (replay) pending.push(Promise.resolve(replay.stop()).catch(() => {}));
    this.ringBuffer.clear();
    this.lifecycleSuspended = true;
    void this.resumeFromLifecycle(true);
    this.configureAutoFlagController();
    const deadline = Date.now() + PAGEHIDE_PENDING_SEND_TIMEOUT_MS;
    const retirement = this.waitUntilLifecycleDeadline(
      Promise.allSettled(pending).then(() => true),
      deadline,
    )
      .then((settled) =>
        settled
          ? this.waitUntilLifecycleDeadline(
              Promise.resolve()
                .then(() => this.transport.endSession(previousId))
                .then(
                  () => true,
                  () => true,
                ),
              deadline,
            )
          : undefined,
      )
      .then(() => undefined)
      .catch(() => {})
      .finally(() => this.pendingSends.delete(retirement));
    this.pendingSends.add(retirement);
  }

  /** Schedule a close for a page that remains hidden after lifecycle events settle. */
  private scheduleLifecycleClose(): void {
    if (
      this.stopped ||
      this.lifecycleSuspended ||
      this.lifecycleClosing ||
      this.lifecycleClosePromise ||
      this.lifecycleTimer !== undefined
    )
      return;
    this.lifecycleTimer = setTimeout(() => {
      this.lifecycleTimer = undefined;
      void this.closeForLifecycle(false);
    }, PAGE_HIDDEN_END_DELAY_MS);
  }

  private cancelLifecycleTimer(): void {
    if (this.lifecycleTimer === undefined) return;
    clearTimeout(this.lifecycleTimer);
    this.lifecycleTimer = undefined;
  }

  /**
   * Close one browser visit without tearing down the instance.
   *
   * A hidden page can return from the back forward cache. The collectors and
   * bus therefore stay installed, but capture is suspended after the final
   * batch and resumes under a new session id when the page becomes visible.
   * The final event sends and session start are awaited before endSession so
   * the server cannot finalize an incomplete log.
   */
  private closeForLifecycle(immediateEnd: boolean): Promise<void> {
    this.cancelDurationTimer();
    if (this.stopped || this.lifecycleSuspended) {
      return this.lifecycleClosePromise ?? Promise.resolve();
    }
    if (this.lifecycleClosePromise) {
      if (immediateEnd) this.escalateLifecycleClose();
      return this.lifecycleClosePromise;
    }

    const closeState: NonNullable<typeof this.lifecycleCloseState> = {
      immediateEnd,
      ...(immediateEnd
        ? { deadline: Date.now() + PAGEHIDE_PENDING_SEND_TIMEOUT_MS }
        : {}),
    };
    if (!immediateEnd) {
      closeState.escalationPromise = new Promise<void>((resolve) => {
        closeState.escalate = resolve;
      });
    }
    this.lifecycleCloseState = closeState;

    this.lifecycleClosePromise = (async () => {
      // Flush while transport admission is still open. Setting the lifecycle
      // gate first would make the subscriber discard the final batch.
      this.applicationExpectations.stop();
      this.bus.flush();
      // Anything still held belongs to the session that is ending. Carrying it
      // past the close would replay pre-suspend events, with pre-suspend
      // timestamps, into the new session `resumeFromLifecycle` mints. The
      // discard is declared: this session is still sending, so it can say what
      // it lost rather than ending with a first screen that never existed.
      const discarded =
        this.pendingAdmissionEvents.length + this.pendingAdmissionDropped;
      this.pendingAdmissionEvents = [];
      this.pendingAdmissionDropped = 0;
      this.pendingAdmissionBytes = 0;
      this.pendingAdmissionMasking = undefined;
      if (discarded > 0) {
        // Queued rather than emitted: the bus gate closes on the next line, so
        // an emit here would be refused. The deferred queue is sent by this
        // close, before `endSession`.
        this.deferredDeliveryGaps.push(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "session_ended_unanswered",
            droppedEventCount: discarded,
            sessionId: this.sessionId,
          }),
        );
      }
      this.lifecycleClosing = true;
      this.expirePersistedVisit();
      try {
        const admissionSettled = await this.waitForLifecyclePhase(
          [this.sessionMetadataWrite, this.sessionAdmission],
          closeState,
        );
        if (!admissionSettled) {
          this.abandonLifecycleSends();
          this.lifecycleSuspended = true;
          this.sessionStarted = false;
          return;
        }
        const pendingSettled = await this.waitForLifecycleSends(closeState);
        if (!pendingSettled) {
          this.lifecycleSuspended = true;
          this.sessionStarted = false;
          return;
        }

        const replay = this.replay;
        this.replay = undefined;
        const replaySettled = replay
          ? await this.waitForLifecycleOperation(
              Promise.resolve()
                .then(() => replay.stop())
                .catch(() => {}),
              closeState,
            )
          : true;
        if (!replaySettled) {
          this.lifecycleSuspended = true;
          this.sessionStarted = false;
          return;
        }

        if (this.deferredDeliveryGaps.length > 0) {
          const deferred = this.deferredDeliveryGaps;
          this.deferredDeliveryGaps = [];
          const deferredSettled = await this.waitForLifecycleOperation(
            Promise.resolve()
              .then(() => this.transport.sendEvents(deferred))
              .catch(() => {}),
            closeState,
          );
          if (!deferredSettled) {
            this.lifecycleSuspended = true;
            this.sessionStarted = false;
            return;
          }
        }
        this.startLifecycleEnd();
        const lifecycleEndSettled = await this.waitForLifecycleEnd(closeState);
        if (!lifecycleEndSettled) {
          this.sessionStarted = false;
          this.lifecycleSuspended = true;
          return;
        }
        // The lifecycle end finalized this session. Mark it closed before releasing the
        // lifecycle promise so a later explicit stop cannot end the same session again.
        this.sessionStarted = false;
        this.lifecycleSuspended = true;
      } finally {
        this.lifecycleClosing = false;
      }
    })().finally(() => {
      this.lifecycleClosePromise = undefined;
      this.lifecycleEndPromise = undefined;
      this.lifecycleCloseState = undefined;
    });
    return this.lifecycleClosePromise;
  }

  /**
   * Wait for in-flight delivery before finalizing a session. Ordinary hidden-page suspension can
   * wait without a deadline. A nonpersisted pagehide gets a bounded wait because the page may be
   * torn down at any moment, and a late end request is worse than letting the server TTL reclaim
   * a session whose last upload did not finish.
   */
  private async waitForLifecycleSends(
    closeState: NonNullable<typeof this.lifecycleCloseState>,
  ): Promise<boolean> {
    const pending = [...this.pendingSends];
    if (pending.length === 0) return true;
    const settled = Promise.allSettled(pending).then(() => true);
    const completed = await this.waitForLifecyclePhase(
      pending,
      closeState,
      settled,
    );
    if (!completed) this.abandonLifecycleSends(pending);
    return completed;
  }

  /**
   * Wait for one lifecycle phase under its close deadline. An ordinary hidden-page close waits
   * indefinitely until an explicit stop or nonpersisted pagehide escalates it to the bounded path.
   */
  private async waitForLifecyclePhase(
    promises: readonly Promise<unknown>[],
    closeState: NonNullable<typeof this.lifecycleCloseState>,
    settled = Promise.allSettled(promises).then(() => true),
  ): Promise<boolean> {
    if (promises.length === 0) return true;
    if (!closeState.immediateEnd) {
      const escalated = closeState.escalationPromise?.then(() => false);
      if (escalated) {
        const completed = await Promise.race([settled, escalated]);
        if (completed) return true;
      } else {
        await settled;
        return true;
      }
    }
    return this.waitUntilLifecycleDeadline(settled, closeState.deadline);
  }

  /** Wait for lifecycle end, applying a deadline once an explicit close is requested. */
  private async waitForLifecycleEnd(
    closeState: NonNullable<typeof this.lifecycleCloseState>,
  ): Promise<boolean> {
    if (!this.lifecycleEndPromise) return true;
    return this.waitForLifecycleOperation(this.lifecycleEndPromise, closeState);
  }

  private async waitForLifecycleOperation(
    operation: Promise<unknown>,
    closeState: NonNullable<typeof this.lifecycleCloseState>,
  ): Promise<boolean> {
    const settled = operation.then(
      () => true,
      () => true,
    );
    if (!closeState.immediateEnd) {
      const escalated = closeState.escalationPromise?.then(() => false);
      if (escalated) {
        const completed = await Promise.race([settled, escalated]);
        if (completed) return true;
      } else {
        await settled;
        return true;
      }
    }
    return this.waitUntilLifecycleDeadline(settled, closeState.deadline);
  }

  private async waitUntilLifecycleDeadline(
    settled: Promise<boolean>,
    deadline = Date.now() + PAGEHIDE_PENDING_SEND_TIMEOUT_MS,
  ): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      settled,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  }

  private abandonLifecycleSends(pending = [...this.pendingSends]): void {
    // Do not let a transport that never settles keep a later explicit stop() hostage. The page
    // is already closing and the server can finalize this still-open session by TTL.
    for (const send of pending) this.pendingSends.delete(send);
  }

  private escalateLifecycleClose(): void {
    const closeState = this.lifecycleCloseState;
    if (!closeState || closeState.immediateEnd) return;
    closeState.immediateEnd = true;
    closeState.deadline = Date.now() + PAGEHIDE_PENDING_SEND_TIMEOUT_MS;
    closeState.escalate?.();
  }

  /** Start the unload safe close without waiting for async teardown work. */
  private startLifecycleEnd(): void {
    if (this.lifecycleEndPromise || !this.sessionStarted) return;
    try {
      this.lifecycleEndPromise = Promise.resolve(
        this.transport.endSession(this.sessionId),
      ).catch(() => {});
    } catch {
      this.lifecycleEndPromise = Promise.resolve();
    }
  }

  /** Start a new visit when a hidden page becomes visible again. */
  private resumeFromLifecycle(
    preserveExpectations = false,
  ): Promise<void> | undefined {
    const closing = this.lifecycleClosePromise;
    if (closing) {
      return closing.then(() => {
        void this.resumeFromLifecycle();
      });
    }
    if (this.stopped || !this.lifecycleSuspended) return undefined;

    this.sessionId = generateSessionId();
    this.applicationAssertions = 0;
    this.applicationResponseAssertions = 0;
    if (preserveExpectations) {
      this.applicationExpectations.rotateSession(this.sessionId);
    } else {
      this.applicationExpectations.stop();
      this.applicationExpectations = createApplicationExpectationManager({
        sessionId: this.sessionId,
        emit: (event) => this.bus.emit(event),
      });
    }
    if (this.sessionStore)
      writePersistedSession(this.sessionStore, this.sessionId);
    this.visualArtifactNames.clear();
    this.sessionStarted = false;
    this.lifecycleSuspended = false;
    this.sessionAdmission = Promise.resolve(false);
    this.sessionMetadataWrite = Promise.resolve();
    this.startSessionIfAllowed();
    return this.sessionMetadataWrite;
  }

  private shouldAdmitEvent(event: BugEvent, context?: EmitContext): boolean {
    if (!this.canTransport()) {
      if (this.isAdmissionUndecided()) this.holdForAdmission(event, context);
      return false;
    }
    if (this.isFlightRecorderTerminal()) return false;
    if (!this.samplingShed) return true;
    return event.k === CAPTURE_GAP_EVENT_KIND;
  }

  private shouldPersistEvent(event: BugEvent): boolean {
    if (!this.canTransport()) return false;
    if (this.isFlightRecorderTerminal()) return false;
    if (event.k === CAPTURE_GAP_EVENT_KIND) return true;
    return (
      !this.samplingShed &&
      (!this.config.flightRecorder ||
        this.flightRecorderState === "triggered" ||
        this.flightRecorderState === "tailing" ||
        this.baselineSampled)
    );
  }

  private canCapture(): boolean {
    return this.canTransport() && !this.samplingShed;
  }

  private isFlightRecorderTerminal(): boolean {
    return (
      this.config.flightRecorder && this.flightRecorderState === "finalizing"
    );
  }

  private canTransport(): boolean {
    return (
      !this.inert &&
      !this.stopped &&
      !this.lifecycleClosing &&
      !this.lifecycleSuspended &&
      this.remotePolicyReady &&
      this.consentGranted &&
      !this.killSwitch
    );
  }

  private startSessionIfAllowed(): void {
    if (!this.canTransport()) return;
    if (this.sessionStarted) {
      if (
        this.durationDeadline !== undefined &&
        Date.now() >= this.durationDeadline
      )
        this.rotateActiveSession();
      return;
    }
    if (
      this.config.flightRecorder &&
      this.flightRecorderState !== "triggered" &&
      this.flightRecorderState !== "tailing" &&
      !this.baselineSampled &&
      !this.samplingShed
    )
      return;
    this.sessionStarted = true;
    this.startSessionWithCurrentIdentity();
    this.scheduleDurationRotation();
    this.updateReplayState();
  }

  /**
   * Start or stop session replay to match the project's setting.
   *
   * Only ever recorded for a session that is already being sent: a replay of a
   * session the server has no row for is an artifact nothing can reach.
   *
   * Masking is fixed for the life of a recording. A manifest states one masking
   * mode, and a recording whose second half was taken under a different one
   * would be a recording no reader could characterize. A changed setting takes
   * effect on the next session, which is what the settings page says it does.
   */
  private updateReplayState(): void {
    const shouldRecord =
      this.replayEnabled &&
      this.sessionStarted &&
      this.canTransport() &&
      replaySupported();
    if (shouldRecord) {
      if (this.replay) return;
      const replaySessionId = this.sessionId;
      this.replay = new ReplayRecorder({
        sessionId: replaySessionId,
        masking: this.replayMasking,
        ...this.applicationRelease,
        sdkVersion: CRUMBTRAIL_SDK_VERSION,
        send: (name, body) => {
          const sendBlob = this.transport.sendBlob as (
            name: string,
            blob: Blob,
            metadata?: Record<string, unknown>,
            sessionId?: string,
            allowPreviousSession?: boolean,
          ) => Promise<void>;
          return sendBlob.call(
            this.transport,
            name,
            body,
            undefined,
            replaySessionId,
            true,
          );
        },
      });
      this.replay.start();
      return;
    }
    const running = this.replay;
    this.replay = undefined;
    // Detached rather than awaited: this runs from a config poll, and a poll
    // must not wait on an upload. `stop` flushes what it has before it tears
    // down, so the buffered tail still lands.
    void running?.stop().catch(() => {});
  }

  /**
   * Records that a batch never reached the capture endpoint.
   *
   * Without this a refused batch is silently discarded and the session reports
   * itself complete, which is the one failure mode a capture product cannot
   * have: a reader has no way to tell "nothing went wrong" from "the evidence
   * was thrown away". The gap is bounded so a failing endpoint cannot turn into
   * its own event storm, and a batch of gap records never produces another gap.
   */
  private recordDeliveryFailure(events: BugEvent[], error: unknown): void {
    // A gap about a batch of gaps would recurse for as long as the endpoint
    // stays down.
    if (events.every((event) => event.k === CAPTURE_GAP_EVENT_KIND)) return;
    // Counted before the cap, so the running total stays true even once the
    // records stop. A storm produces hundreds of failures; three records that
    // together name sixty events would read as a rounding error rather than
    // the session's evidence being mostly gone.
    this.deliveryDroppedEvents += events.length;
    if (this.deliveryGapsEmitted >= MAX_DELIVERY_GAP_EVENTS) return;
    this.deliveryGapsEmitted += 1;
    this.deliveryDroppedDeclared += events.length;
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : undefined;
    const gap = buildCaptureGapEvent({
      surface: "browser",
      reason: "delivery_failed",
      droppedEventCount: events.length,
      ...(Number.isFinite(status) && status !== 0
        ? { detail: `HTTP ${status}` }
        : {}),
      sessionId: this.sessionId,
    });
    // Queued rather than emitted during teardown, and sent directly in stop().
    // Emitting both ways would duplicate the record.
    if (this.stopped || this.lifecycleClosing)
      this.deferredDeliveryGaps.push(gap);
    else this.bus.emit(gap);
  }

  /**
   * Registers a collector that must not release unrepeatable evidence until
   * admission has been decided. Settles immediately when the answer is already
   * known, so a session with no remote policy pays nothing.
   */
  private whenCaptureAdmitted(settle: (admitted: boolean) => void): void {
    if (this.canTransport()) {
      this.runAdmissionWaiter(settle, true);
      return;
    }
    if (this.isCaptureDenied()) {
      this.runAdmissionWaiter(settle, false);
      return;
    }
    this.admissionWaiters.push(settle);
  }

  /**
   * Denied for good, as opposed to merely undecided.
   *
   * Consent that has not been granted yet is NOT a denial: `consentMode:
   * "explicit"` grants it later in the same session, and discarding the early
   * queue the moment init runs would throw away the first-screen requests of
   * every consent-gated app. Only an explicit `consent(false)` decides against.
   */
  private isCaptureDenied(): boolean {
    if (this.stopped || this.killSwitch || this.explicitConsent === false)
      return true;
    // Global Privacy Control is an answer, not a pending question: a suppressed
    // session would otherwise hold evidence forever, waiting for a consent call
    // the host has already been told not to make.
    //
    // Except under `consentMode: "required"`, where the host is expected to
    // answer and may still answer yes. Destroying the early queue on the first
    // poll would take the first screen away from every consent-gated app,
    // which is the loss this hold exists to prevent. Those events rest in page
    // memory and reach the wire only if consent is granted.
    return (
      this.explicitConsent === undefined &&
      this.config.consentMode !== "required" &&
      Boolean(this.config.respectGpc) &&
      hasGlobalPrivacyControl()
    );
  }

  /**
   * Is capture still waiting for an answer, as opposed to running or refused?
   *
   * True only while the remote capture policy is in flight or explicit consent
   * has not been given yet — the two states that resolve later in the same
   * session. A closing or suspended lifecycle is not one of them: those events
   * belong to a session that is ending, and holding them would replay them into
   * a session that has already been finalized.
   */
  private isAdmissionUndecided(): boolean {
    if (this.inert || this.lifecycleClosing || this.lifecycleSuspended)
      return false;
    if (this.isCaptureDenied()) return false;
    return !this.remotePolicyReady || !this.consentGranted;
  }

  /** Parks one event until {@link settleAdmissionWaiters} decides its fate. */
  private holdForAdmission(event: BugEvent, context?: EmitContext): void {
    // A shed session records nothing but the gap that says it was shed, so
    // there is nothing here worth holding for it.
    if (this.samplingShed && event.k !== CAPTURE_GAP_EVENT_KIND) return;
    // An event the release pass just emitted must never fall back into the
    // hold it came out of.
    if (this.releasingAdmissionHold) return;
    this.pendingAdmissionMasking ??= readMaskingState(this.config);
    // The raw URL rides on the hold entry, never on the event: it exists so the
    // release pass can match `excludeUrls` against what the application asked
    // for rather than against the redacted copy, and it is dropped with the
    // entry.
    const bytes = estimateHeldEventBytes(event);
    this.pendingAdmissionEvents.push({
      event,
      bytes,
      ...(context?.rawUrl !== undefined ? { rawUrl: context.rawUrl } : {}),
    });
    this.pendingAdmissionBytes += bytes;
    // Oldest first, matching the bus buffer: the events nearest whatever opens
    // the gate are the ones a reader is looking for. Both ceilings evict the
    // same way, so one loop serves them. The byte ceiling never empties the
    // hold: one event over the limit is kept rather than losing the newest
    // thing that happened.
    while (
      this.pendingAdmissionEvents.length > MAX_PENDING_ADMISSION_EVENTS ||
      (this.pendingAdmissionBytes > MAX_PENDING_ADMISSION_BYTES &&
        this.pendingAdmissionEvents.length > 1)
    ) {
      const evicted = this.pendingAdmissionEvents.shift();
      if (!evicted) break;
      this.pendingAdmissionBytes -= evicted.bytes;
      this.pendingAdmissionDropped += 1;
    }
  }

  /**
   * Empties the hold. Admitted events are re-emitted in the order they were
   * held, which is the order they were captured in among themselves, with their
   * original timestamps, so a request and its response sit where they happened
   * rather than where the policy landed. It says nothing about where they sit
   * relative to events captured after the gate opened, which are already out.
   */
  private releasePendingAdmissionEvents(admitted: boolean): void {
    const held = this.pendingAdmissionEvents;
    const overflowDropped = this.pendingAdmissionDropped;
    let policyDropped = 0;
    const heldMasking =
      this.pendingAdmissionMasking ?? readMaskingState(this.config);
    this.pendingAdmissionEvents = [];
    this.pendingAdmissionDropped = 0;
    this.pendingAdmissionBytes = 0;
    this.pendingAdmissionMasking = undefined;
    if (!admitted || held.length === 0) return;

    // The policy that just opened the gate may also have narrowed what may be
    // captured, and these events were BUILT before it arrived. Each one is
    // re-asked under the current policy and dropped when it no longer passes.
    // Nothing bypasses admission: the same predicate that gates a live event
    // gates a released one.
    this.releasingAdmissionHold = true;
    try {
      for (const entry of held) {
        const allowed = reapplyPolicyToHeldEvent(entry.event, this.config, {
          heldMasking,
          samplingShed: this.samplingShed,
          ...(entry.rawUrl !== undefined ? { rawUrl: entry.rawUrl } : {}),
        });
        if (!allowed) {
          policyDropped += 1;
          continue;
        }
        if (!this.bus.emit(allowed)) policyDropped += 1;
      }
    } finally {
      this.releasingAdmissionHold = false;
    }

    // Two reasons, two records. They mean opposite things about a deployment:
    // the cap firing says the hold was too small for the page, the policy pass
    // dropping events says the policy did its job.
    if (overflowDropped > 0) {
      this.bus.emit(
        buildCaptureGapEvent({
          surface: "browser",
          reason: "buffer_overflow",
          droppedEventCount: overflowDropped,
          sessionId: this.sessionId,
        }),
      );
    }
    if (policyDropped > 0) {
      this.bus.emit(
        buildCaptureGapEvent({
          surface: "browser",
          reason: "policy_tightened",
          droppedEventCount: policyDropped,
          sessionId: this.sessionId,
        }),
      );
    }
  }

  private runAdmissionWaiter(
    settle: (admitted: boolean) => void,
    admitted: boolean,
  ): void {
    try {
      settle(admitted);
    } catch {
      // A collector that throws on release never becomes the host app's problem.
    }
  }

  /**
   * Answers every waiting collector, once admission is decided either way.
   * A no-op while the answer is still pending, which is what keeps the early
   * queue held rather than discarded.
   */
  private settleAdmissionWaiters(): void {
    const admitted = this.canTransport();
    if (!admitted && !this.isCaptureDenied()) return;
    // Waiters first: they hold the pre-init early queue, which is older than
    // anything the bus held, so releasing it first keeps the emitted order
    // chronological.
    const waiters = this.admissionWaiters;
    this.admissionWaiters = [];
    for (const waiter of waiters) this.runAdmissionWaiter(waiter, admitted);
    this.releasePendingAdmissionEvents(admitted);
  }

  private clearRemotePolicyTimer(): void {
    if (this.remotePolicyTimer !== undefined) {
      clearTimeout(this.remotePolicyTimer);
      this.remotePolicyTimer = undefined;
    }
  }

  /**
   * Opens the gate on the local config when the remote policy cannot be had,
   * and records a `policy_unavailable` gap so the session states what it fell
   * back to instead of looking like a session where nothing happened. Polling
   * continues: a policy that arrives later still applies.
   */
  private applyRemotePolicyFallback(): void {
    this.clearRemotePolicyTimer();
    if (this.remotePolicyReady || this.stopped) return;
    this.remotePolicyReady = true;
    this.updateFlightRecorderState();
    this.startSessionIfAllowed();
    this.settleAdmissionWaiters();
    this.emitSamplingGapIfNeeded();
    this.bus.emit(
      buildCaptureGapEvent({
        surface: "browser",
        reason: "policy_unavailable",
        sessionId: this.sessionId,
      }),
    );
  }

  private emitSamplingGapIfNeeded(): void {
    if (!this.samplingShed || this.samplingGapEmitted || !this.canTransport())
      return;
    this.samplingGapEmitted = true;
    this.bus.emit(
      buildCaptureGapEvent({
        surface: "browser",
        reason: "sampled_out",
        sessionId: this.sessionId,
      }),
    );
    this.bus.flush();
  }

  private createBugId(): string {
    return `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  mark(label: string): void {
    this.bus.emit({ t: now(), k: "mark", d: { label } });
  }

  /**
   * Record a bounded application-owned correctness claim.
   *
   * The SDK never infers a claim from a response or a UI state. The host must
   * provide both values, and invalid values are rejected before the event bus
   * sees them. `assert()` is a convenience that returns the computed result;
   * `reportAssertion()` exposes the admission result for callers that need to
   * distinguish a failed claim from a refused one.
   */
  reportAssertion(
    options: ApplicationAssertionOptions,
  ): ApplicationAssertionResult {
    const result = buildApplicationAssertionEvent(
      options,
      now(),
      this.sessionId,
    );
    if (!result.accepted || result.event === undefined) return result;
    if (!this.canCapture()) {
      return { accepted: false, rejection: "capture_not_admitted" };
    }
    if (
      this.applicationAssertions + this.pendingApplicationAssertions >=
      MAX_APPLICATION_ASSERTIONS_PER_SESSION
    ) {
      return { accepted: false, rejection: "session_cap_reached" };
    }
    this.pendingApplicationAssertions += 1;
    let admitted = false;
    try {
      admitted = this.bus.emit(result.event);
    } catch {
      admitted = false;
    } finally {
      this.pendingApplicationAssertions -= 1;
    }
    if (!admitted) {
      return { accepted: false, rejection: "capture_not_admitted" };
    }
    this.applicationAssertions += 1;
    if (this.sessionStore)
      writePersistedSession(
        this.sessionStore,
        this.sessionId,
        this.applicationAssertions,
        this.applicationResponseAssertions,
        this.applicationExpectations.admittedCount,
      );
    return result;
  }

  assert(options: ApplicationAssertionOptions): boolean {
    return this.reportAssertion(options).passed === true;
  }

  /**
   * Check application-declared facts on a response without capturing the response.
   * Each fact reads one exact safe path or one bounded array selector.
   */
  checkResponse(
    response: unknown,
    facts: readonly ApplicationResponseFactOptions[],
    correlation: ApplicationResponseCorrelation = {},
  ): ApplicationResponseCheckResult {
    const built = checkApplicationResponse(
      response,
      facts,
      now(),
      correlation,
      this.sessionId,
    );
    let acceptedCount = 0;
    const results = built.results.map((result) => {
      if (!result.accepted || result.event === undefined) return result;
      if (!this.canCapture())
        return { accepted: false, rejection: "capture_not_admitted" as const };
      if (
        this.applicationResponseAssertions +
          this.pendingApplicationResponseAssertions >=
        MAX_APPLICATION_RESPONSE_ASSERTIONS_PER_SESSION
      ) {
        return {
          accepted: false,
          rejection: "response_session_cap_reached" as const,
        };
      }
      this.pendingApplicationResponseAssertions += 1;
      let admitted = false;
      try {
        admitted = this.bus.emit(result.event);
      } catch {
        admitted = false;
      } finally {
        this.pendingApplicationResponseAssertions -= 1;
      }
      if (!admitted)
        return { accepted: false, rejection: "capture_not_admitted" as const };
      this.applicationResponseAssertions += 1;
      if (this.sessionStore)
        writePersistedSession(
          this.sessionStore,
          this.sessionId,
          this.applicationAssertions,
          this.applicationResponseAssertions,
          this.applicationExpectations.admittedCount,
        );
      acceptedCount += 1;
      return result;
    });
    return {
      ...built,
      accepted: acceptedCount > 0,
      acceptedCount,
      results,
    };
  }

  reportResponse(
    response: unknown,
    facts: readonly ApplicationResponseFactOptions[],
    correlation: ApplicationResponseCorrelation = {},
  ): ApplicationResponseCheckResult {
    return this.checkResponse(response, facts, correlation);
  }

  /** Begin a provider-neutral declaration that an application effect should occur. */
  expectSideEffect(
    options: ApplicationExpectationOptions,
  ): ApplicationExpectationResult {
    if (!this.canCapture())
      return { accepted: false, rejection: "capture_not_admitted" };
    const result = this.applicationExpectations.begin(options);
    if (result.accepted && this.sessionStore)
      writePersistedSession(
        this.sessionStore,
        this.sessionId,
        this.applicationAssertions,
        this.applicationResponseAssertions,
        this.applicationExpectations.admittedCount,
      );
    return result;
  }

  beginExpectation(
    options: ApplicationExpectationOptions,
  ): ApplicationExpectationResult {
    return this.expectSideEffect(options);
  }

  addEvent(partial: AddBugEventOptions): boolean {
    const { type, data, ...envelope } = partial;
    return this.bus.emit({
      t: now(),
      k: type,
      d: redactDatabaseEventValues(type, data),
      ...envelope,
    });
  }

  /** Record an error that application code caught and handled. */
  recordError(error: unknown, options?: RecordErrorOptions): void {
    this.bus.emit({
      t: now(),
      k: "err",
      d: buildRecordedErrorData(error, options, this.config),
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  createRequestHeaders(requestId?: string): Record<string, string> {
    return createCrumbtrailRequestHeaders(this.sessionId, requestId);
  }

  pause(): void {
    this.bus.pause();
  }

  resume(): void {
    this.bus.resume();
    // A pause the host held long enough to overrun the buffer cost events. The
    // session says how many rather than resuming as if it had not.
    const dropped = this.bus.takeDroppedEventCount();
    if (dropped === 0) return;
    this.bus.emit(
      buildCaptureGapEvent({
        surface: "browser",
        reason: "buffer_overflow",
        droppedEventCount: dropped,
        sessionId: this.sessionId,
      }),
    );
    this.bus.flush();
  }

  registerStateProvider(name: string, provider: () => unknown): () => void {
    this.stateProviders.set(name, provider);
    return () => {
      this.stateProviders.delete(name);
    };
  }

  /**
   * Declaratively attach vendor-agnostic feature flags / config to the session environment.
   * Values are redacted before they rest. Merges into the declared env; if the initial
   * `k:'env'` snapshot has already been emitted (the normal case, since `setEnv` is called
   * after `init`), it emits a `k:'env'` delta event ({ kind:'delta' }) scoped to what actually
   * moved: `flags`/`config` carry only the changed keys, and `flagChanges` carries the
   * before/after pair for each changed flag. A re-declaration that changes nothing emits no
   * event at all, so a reader can tell "the app re-declares its flags on every route change"
   * from "the flag flipped mid session". If called before the snapshot is emitted (e.g.
   * environment collector disabled or not yet run), the values are folded into the snapshot
   * instead and nothing is emitted.
   */
  setEnv(declaration: EnvDeclaration): void {
    // `diffFlags` treats `next` as an authoritative full re-declaration, which is what makes a
    // removal detectable. `setEnv` is documented as MERGE semantics, so the incoming
    // declaration is a partial — handing it over directly would report every untouched key as
    // a removal. Compare against the post-merge state instead. The honest consequence: a
    // removal is unreachable through `setEnv`, because merging cannot remove a key.
    const flagDiff = declaration.flags
      ? diffFlags(this.declaredFlags, {
          ...this.declaredFlags,
          ...declaration.flags,
        })
      : undefined;
    const configDiff = declaration.config
      ? diffFlags(this.declaredConfig, {
          ...this.declaredConfig,
          ...declaration.config,
        })
      : undefined;

    if (declaration.flags) Object.assign(this.declaredFlags, declaration.flags);
    if (declaration.config)
      Object.assign(this.declaredConfig, declaration.config);

    if (!this.envEmitted) return;

    const changedFlagKeys = flagDiff ? Object.keys(flagDiff.changed) : [];
    const changedConfigKeys = configDiff ? Object.keys(configDiff.changed) : [];
    if (changedFlagKeys.length === 0 && changedConfigKeys.length === 0) return;

    const delta = buildEnvDelta(
      pickKeys(this.declaredFlags, changedFlagKeys),
      pickKeys(this.declaredConfig, changedConfigKeys),
      {
        diagnosticFields: this.config.redaction?.diagnosticFields,
        denyFields: this.config.redaction?.denyFields,
      },
    );

    if (flagDiff && changedFlagKeys.length > 0) {
      // `from`/`to` hold real flag values, and a flag value carries a secret exactly as easily
      // as a flag key does — a rotated API key moves through here as a "change".
      //
      // Each side is redacted as `{ [flagKey]: value }` under `env.flags`, the same path and
      // therefore the same key-aware policy the snapshot applies. Redacting the whole
      // `changed` record in one pass would not do: a sensitive flag NAME would collapse the
      // entire `{ from, to }` wrapper to the placeholder string, destroying the shape the
      // field exists to carry.
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const metadata: Array<RedactionMetadata | undefined> = [
        delta.redaction as RedactionMetadata | undefined,
      ];
      for (const key of changedFlagKeys) {
        const change = flagDiff.changed[key];
        const from = redactFlagSide(key, change.from, {
          diagnosticFields: this.config.redaction?.diagnosticFields,
          denyFields: this.config.redaction?.denyFields,
        });
        const to = redactFlagSide(key, change.to, {
          diagnosticFields: this.config.redaction?.diagnosticFields,
          denyFields: this.config.redaction?.denyFields,
        });
        metadata.push(from.metadata, to.metadata);
        if (from.value?.value === undefined && to.value?.value === undefined)
          continue;
        changes[key] = { from: from.value, to: to.value };
      }
      delta.flagChanges = changes as EnvSnapshot["flagChanges"];
      const merged = mergeRedactionMetadata(...metadata);
      if (merged) delta.redaction = dedupeRedactionFields(merged);
    }

    this.bus.emit({
      t: now(),
      k: "env",
      d: delta as unknown as Record<string, unknown>,
    });
  }

  stop(): Promise<{ sessionId: string }> {
    if (this.stopPromise) return this.stopPromise;
    this.screenshotClosing = true;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<{ sessionId: string }> {
    this.cancelDurationTimer();
    const teardownFailures: StopFailure[] = [];
    const runTeardown = (
      label: string,
      teardown: (() => void) | undefined,
    ): void => {
      if (!teardown) return;
      try {
        teardown();
      } catch (error) {
        recordStopFailure(teardownFailures, label, error);
      }
    };

    if (this.transport.abortPendingSessionStart) {
      runTeardown("transport.abortPendingSessionStart", () =>
        this.transport.abortPendingSessionStart?.(),
      );
    }
    this.cancelLifecycleTimer();
    const stopState: NonNullable<typeof this.lifecycleCloseState> & {
      deadline: number;
    } = {
      immediateEnd: true,
      deadline: Date.now() + PAGEHIDE_PENDING_SEND_TIMEOUT_MS,
    };
    if (this.lifecycleClosePromise) {
      try {
        this.escalateLifecycleClose();
        await this.lifecycleClosePromise;
      } catch (error) {
        recordStopFailure(teardownFailures, "lifecycle.close", error);
      }
    } else if (this.sessionStarted && !this.lifecycleSuspended) {
      const admissionSettled = await this.waitUntilLifecycleDeadline(
        Promise.allSettled([
          this.sessionMetadataWrite,
          this.sessionAdmission,
        ]).then(() => true),
        stopState.deadline,
      );
      if (!admissionSettled) {
        this.abandonLifecycleSends();
        this.lifecycleSuspended = true;
        this.sessionStarted = false;
      }
    }
    // A session ending while the remote policy is still outstanding takes the
    // same fallback the timeout takes: open on the local config, say so with a
    // gap, and release the collectors still holding unrepeatable evidence — the
    // early queue above all. This runs BEFORE the flush and before `stopped` is
    // set, because after either one the released events meet a bus that refuses
    // them, which is the failure the handshake exists to prevent.
    this.applyRemotePolicyFallback();
    this.clearRemotePolicyTimer();
    this.settleAdmissionWaiters();
    // Missed application expectations are part of the final evidence window and
    // must be emitted before the final flush while the bus is still live.
    this.applicationExpectations.stop();
    // Ship everything captured up to this instant BEFORE tearing down.
    // shouldPersistEvent consults canTransport(), which is false once
    // `stopped` is set — so a flush that runs after the flag would hand the
    // final batch to a subscriber that drops every event in it. That batch is
    // the last flush-interval of the session: on a fast flow it holds the
    // failing click and its request, the exact evidence the session exists
    // to keep. It is flushed ahead of the cleanup loop as well as ahead of the
    // flag, so a collector that throws on teardown cannot take the session's
    // last batch down with it.
    this.bus.flush();
    // Session replay is torn down first, and awaited. Two reasons it belongs
    // here rather than after the flag:
    //
    // Its last chunk is the interval a session that ended in a failure was
    // failing in, and it uploads through `transport.sendBlob` against a session
    // the server still has open — so it has to land before `endSession()`
    // finalizes the log below. Awaiting it inline is what makes that ordering
    // real while the deadline keeps a stuck recorder from holding shutdown;
    // `updateReplayState()` may only detach the same call because a config
    // poll must not block on an upload.
    //
    // And it runs while the session is still live, on the same side of the flag
    // as the collector loop. The recorder reaches the transport directly rather
    // than through the bus, so nothing it does today is dropped by
    // `canTransport()` — but a recorder that tears down before the flag cannot
    // start depending on that, and this is the side that stays correct.
    //
    // Guarded like every other teardown in this sequence. `ReplayRecorder.stop()`
    // is `async`, so a throw inside it arrives as the rejection `.catch()`
    // already absorbs and the `try` is redundant today; it is here so that the
    // rule holds by inspection rather than by everyone re-deriving that fact,
    // because a `stop` that ever threw past that chain would strand the second
    // flush, the flag, `abortFlightRecorder()` and `endSession()`.
    const replay = this.replay;
    this.replay = undefined;
    if (replay) {
      const replaySettled = await this.waitUntilLifecycleDeadline(
        Promise.resolve()
          .then(() => replay.stop())
          .then(
            () => true,
            (error: unknown) => {
              recordStopFailure(teardownFailures, "replay", error);
              return true;
            },
          ),
        stopState.deadline,
      );
      if (!replaySettled) {
        this.lifecycleSuspended = true;
        this.sessionStarted = false;
      }
    }
    // These three run BEFORE the collector loop and are teardown in exactly the
    // same sense, so they answer to the same rule: a throw here must not strand
    // everything below. `widgetCleanup` is DOM teardown against nodes the host
    // page owns and may have moved or removed, which is the most plausible throw
    // in the whole of stop(). Unguarded, it skipped the collector loop, both
    // flushes and `abortFlightRecorder()`, leaving a pending flag() tail promise
    // that never settles for the caller awaiting it.
    runTeardown("widget", this.widgetCleanup);
    runTeardown("autoFlag", this.autoFlagCleanup);
    runTeardown("configPolling", () => this.stopConfigPolling());
    // Collector cleanup is not only teardown: the performance collector's
    // finalizers emit the scores that are knowable nowhere else — `inp`,
    // `cls.score`, `lcp.final` — from this loop. So the loop runs, and its
    // emissions are flushed, while the session is still live. Setting
    // `stopped` first would have handed those three straight to a subscriber
    // that drops everything, and an app that calls stop() explicitly rather
    // than letting the tab go hidden would lose its vitals entirely.
    this.cleanups.forEach((cleanup, index) =>
      runTeardown(`cleanup[${index}]`, cleanup),
    );
    // Registry collectors live in their own map so a policy switch can reach exactly one of
    // them. At shutdown they are the same list, torn down after `cleanups` to keep the order
    // init installed them in — the performance collector's finalizers still emit from here, so
    // the severity tap and the flush below must both still be in place.
    // `teardownCollector` guards each call, for the reason the loop above states, and removes
    // the key as it goes, so a second stop() cannot run any of them twice.
    for (const key of [...this.collectorTeardowns.keys()]) {
      const error = this.teardownCollector(key);
      if (error) recordStopFailure(teardownFailures, `collector:${key}`, error);
    }
    // Every cleanup has now run, so the list holds nothing but closures over
    // collector state that the teardown just released. Dropped alongside the
    // ring buffer and the state providers below, and dropped here so a second
    // stop() cannot run any of them twice.
    this.cleanups = [];
    this.widgetCleanup = undefined;
    this.autoFlagCleanup = undefined;
    this.bus.flush();
    this.stopped = true;
    // Kept after the flag, where it has always been: with `stopped` set,
    // canCapture() is false, so an armed recorder settles to "armed" rather
    // than reopening as "buffering" on the way out. The session replay
    // recorder is torn down at the top of stop() instead, for the opposite
    // reason: see there.
    this.abortFlightRecorder();
    this.stateProviders.clear();
    this.bus.stop();
    this.expirePersistedVisit();
    this.ringBuffer.clear();
    // The session start owns the binding proof used in its request. Retire the
    // proof only after that request settles, while retaining the transport's
    // existing request bounds and its normal error swallowing.
    const sessionMetadataSettled =
      !this.lifecycleSuspended &&
      (await waitForPromiseWithin(
        this.sessionMetadataWrite,
        Math.max(
          0,
          Math.min(
            SESSION_METADATA_STOP_TIMEOUT_MS,
            stopState.deadline - Date.now(),
          ),
        ),
      ));
    if (sessionMetadataSettled) {
      this.runtimeBinding?.stop();
    } else {
      // A custom transport can return an unbounded promise. Do not attach a
      // shutdown continuation to it: that would retain the instance forever.
      // The binding and all SDK-owned closures are released on this path, and
      // a late session response is intentionally not followed by more work.
      this.runtimeBinding?.stop();
      this.sessionMetadataWrite = Promise.resolve();
      return { sessionId: this.sessionId };
    }
    if (this.sessionStarted) {
      // bus.stop() just flushed the final batch into the transport; every
      // in-flight POST must land before end-of-session finalizes the log.
      const pendingSettled = await this.waitForLifecycleSends(stopState);
      if (!pendingSettled) {
        this.lifecycleSuspended = true;
        this.sessionStarted = false;
      }
      if (!this.sessionStarted) return { sessionId: this.sessionId };
      // A refusal discovered on the final flush has no bus left to ride. The
      // closing record carries whatever the capped per-batch records could not,
      // so the session states its true loss rather than the first few batches
      // of it.
      const undeclared =
        this.deliveryDroppedEvents - this.deliveryDroppedDeclared;
      if (undeclared > 0) {
        this.deferredDeliveryGaps.push(
          buildCaptureGapEvent({
            surface: "browser",
            reason: "delivery_failed",
            droppedEventCount: undeclared,
            sessionId: this.sessionId,
          }),
        );
        this.deliveryDroppedDeclared = this.deliveryDroppedEvents;
      }
      if (this.deferredDeliveryGaps.length > 0) {
        const deferred = this.deferredDeliveryGaps;
        this.deferredDeliveryGaps = [];
        const deferredSettled = await this.waitUntilLifecycleDeadline(
          Promise.resolve()
            .then(() => this.transport.sendEvents(deferred))
            .then(
              () => true,
              () => true,
            ),
          stopState.deadline,
        );
        if (!deferredSettled) {
          this.lifecycleSuspended = true;
          this.sessionStarted = false;
          return { sessionId: this.sessionId };
        }
      }
      const sessionId = this.sessionId;
      try {
        const endSettled = await this.waitUntilLifecycleDeadline(
          Promise.resolve()
            .then(() => this.transport.endSession(sessionId))
            .then(
              () => true,
              (error: unknown) => {
                recordStopFailure(
                  teardownFailures,
                  "transport.endSession",
                  error,
                );
                return true;
              },
            ),
          stopState.deadline,
        );
        if (!endSettled) this.lifecycleSuspended = true;
      } finally {
        // The request may still be in flight after the local deadline. Never retry it from a
        // later stop call, which would finalize the same session twice.
        this.sessionStarted = false;
      }
    }
    if (teardownFailures.length > 0) throw buildStopFailure(teardownFailures);
    return { sessionId: this.sessionId };
  }
}

async function waitForPromiseWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Error-class events that justify flushing ahead of the batch interval:
 * uncaught errors, unhandled promise rejections, failed network
 * responses (HTTP >= 400 or an application-failure body), and network-level
 * request failures (except aborts, which are routine cancellations).
 */
function isSevereEvent(event: BugEvent): boolean {
  return (
    event.k === "err" ||
    event.k === "rej" ||
    isFailedNetworkResponse(event) ||
    (event.k === "net.err" && event.d.name !== "AbortError")
  );
}

function isFailedNetworkResponse(event: BugEvent): boolean {
  return (
    event.k === "net.res" &&
    ((typeof event.d.st === "number" && event.d.st >= 400) ||
      hasApplicationFailure(event.d.body))
  );
}

function hasApplicationFailure(value: unknown): boolean {
  if (typeof value === "string") return hasApplicationFailureInText(value);

  if (Array.isArray(value))
    return value.some((item) => hasApplicationFailure(item));

  if (!isRecord(value) || value.dedup === true) return false;
  if (value.ok === false || value.status === "failed") return true;

  return Object.values(value).some((nested) => hasApplicationFailure(nested));
}

function hasApplicationFailureInText(text: string): boolean {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      if (hasApplicationFailure(JSON.parse(candidate))) return true;
    } catch {
      // Framework response streams can include non-JSON chunks around JSON records.
    }
  }
  return false;
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    candidates.add(trimmed);

  for (const line of trimmed.split(/\r?\n/)) {
    const chunk = line.trim();
    if (!chunk) continue;
    const framed = chunk.match(/^\d+:(.*)$/);
    const unframed = (framed?.[1] ?? chunk).trim();
    if (unframed.startsWith("{") || unframed.startsWith("["))
      candidates.add(unframed);
    const objectStart = unframed.indexOf("{");
    if (objectStart >= 0) candidates.add(unframed.slice(objectStart));
  }

  return [...candidates];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Redact one side of a flag change under the flag's own key, so the key-aware `env.flags`
 * policy sees the flag name exactly as it does in the snapshot. Returns `undefined` unchanged:
 * an absent side means the key did not exist, which is not a value to redact.
 */
function redactFlagSide(
  key: string,
  side: NormalizedFlag | undefined,
  options?: {
    diagnosticFields?: readonly string[];
    denyFields?: readonly string[];
  },
): { value: NormalizedFlag | undefined; metadata?: RedactionMetadata } {
  if (side === undefined) return { value: undefined };
  const result =
    options?.diagnosticFields !== undefined
      ? redactDiagnosticFields(
          { [key]: side.value },
          {
            diagnosticFields: options.diagnosticFields,
            ...(options.denyFields ? { denyFields: options.denyFields } : {}),
            path: "env.flags",
          },
        )
      : redactValue({ [key]: side.value }, "env.flags");
  const redacted = result.value as Record<string, unknown>;
  const value: NormalizedFlag = { value: redacted[key] };
  if (side.variant !== undefined) value.variant = side.variant;
  return { value, ...(result.metadata ? { metadata: result.metadata } : {}) };
}

/**
 * Collapse field entries that repeat because the same flag key was redacted on the delta's
 * `flags` and on both sides of its change record. They describe one decision about one key,
 * so reporting it three times would overstate what was found.
 */
function dedupeRedactionFields(metadata: RedactionMetadata): RedactionMetadata {
  const seen = new Set<string>();
  const fields = metadata.fields.filter((field) => {
    const id = `${field.path}|${field.reason}|${field.action}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { ...metadata, fields };
}

/**
 * Narrow a declared-env record to the named keys. Used to scope a `setEnv` delta to what
 * actually moved, so a re-declaration of twenty flags where one flipped ships one key.
 */
function pickKeys(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key))
      out[key] = source[key];
  }
  return out;
}

/**
 * Say, once, that the reader's own browser turned capture off.
 *
 * `respectGpc` defaults on, and Brave and DuckDuckGo send Global Privacy
 * Control by default, so an integrator on one of those browsers had a correct
 * install, a green setup wizard and permanently empty capture, with no line
 * anywhere naming the cause. The transport never gets a chance to complain
 * because nothing is ever handed to it. Never throws: a host with an unusual
 * console must not be taken down by a diagnostic.
 */
let gpcWarned = false;
function warnGpcSuppressedCapture(): void {
  if (gpcWarned) return;
  gpcWarned = true;
  try {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        "[crumbtrail] this browser sends Global Privacy Control, so nothing is being captured. Some browsers send it by default. Set respectGpc: false in the init config to capture anyway, or use a browser that does not send it.",
      );
    }
  } catch {
    // Diagnostics never break the host page.
  }
}

/**
 * No endpoint configured, so there is nowhere to send anything.
 *
 * `httpEndpoint` used to default to `http://localhost:9898`, the local capture
 * server's port. That server is no longer published, so the default became a
 * closed port: capture ran, every send failed, and the only symptom was a
 * project that stayed empty. Reported once, loudly, at the moment init runs,
 * because the alternative is finding out a day later.
 *
 * This is an error rather than a warning: nothing is captured at all, which is
 * a misconfiguration and not a condition the caller might have chosen.
 */
let endpointWarned = false;
function reportMissingEndpoint(): void {
  if (endpointWarned) return;
  endpointWarned = true;
  try {
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(
        "[crumbtrail] no httpEndpoint was configured, so nothing is being captured. Pass httpEndpoint (your Crumbtrail endpoint) and httpAuthToken (your ingest key) to Crumbtrail.init, or run npx crumbtrail to write them for you.",
      );
    }
  } catch {
    // Diagnostics never break the host page.
  }
}

/** Test seam: the report is once per page, and a suite is one page. */
export function __resetMissingEndpointReportForTests(): void {
  endpointWarned = false;
}

/** Test seam: the warning is once per page, and a suite is one page. */
export function __resetGpcWarningForTests(): void {
  gpcWarned = false;
}

function hasGlobalPrivacyControl(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl,
  );
}

function isSampled(rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (!Number.isFinite(intervalMs) || (intervalMs ?? 0) <= 0)
    return DEFAULT_CONFIG_POLL_INTERVAL_MS;
  return Math.max(1_000, Math.round(intervalMs as number));
}

/**
 * The key this client's capture config poll authenticates with, or `undefined`
 * when it does not poll at all.
 *
 * Both halves are required and neither is asked for twice: `remoteConfig` is on
 * unless the caller turns it off, and the poll authenticates with the ingest key
 * the client already carries. The key is what makes the default safe. A client
 * with no key has no project to ask about, so it stays unpolicied rather than
 * waiting forever on a poll that could never be answered.
 */
function remoteConfigProjectKey(config: CrumbtrailConfig): string | undefined {
  return config.remoteConfig && config.httpAuthToken
    ? config.httpAuthToken
    : undefined;
}

/**
 * Where the capture config poll goes.
 *
 * Derived from `httpEndpoint` the same way the ingest paths are, so the route
 * stays an SDK detail that upgrades with the package instead of a path frozen
 * into every customer's committed source. `configEndpoint` overrides it for a
 * self hosted config service.
 */
function captureConfigEndpoint(config: CrumbtrailConfig): string {
  if (config.configEndpoint) return config.configEndpoint;
  return `${config.httpEndpoint.replace(/\/+$/, "")}/api/capture-config`;
}

function configPollingUrl(
  options: CaptureConfigPollingOptions,
  binding?: RuntimeBinding,
): string {
  const base =
    typeof location !== "undefined" ? location.href : "http://localhost/";
  try {
    const url = new URL(options.endpoint, base);
    url.searchParams.set("projectKey", options.projectKey);
    if (binding) url.searchParams.set("instanceId", binding.instanceId);
    return url.toString();
  } catch {
    return options.endpoint;
  }
}

function currentPageUrl(): string {
  return typeof location !== "undefined" ? redactUrl(location.href).value : "";
}

function pseudonymousId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || EMAIL_SHAPED_VALUE.test(normalized)) return undefined;
  return normalized;
}

/**
 * Accept the deployed response envelope as well as the direct policy shape used by self-hosted
 * config endpoints. Only recognized policy fields are applied below.
 */
function readRemotePolicySettings(
  payload: unknown,
): Record<string, unknown> | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const project = asRecord(root.project);
  const captureConfig =
    asRecord(root.captureConfig) ??
    asRecord(root.capture_config) ??
    asRecord(project?.captureConfig) ??
    asRecord(project?.capture_config);
  const policy =
    asRecord(root.policy) ??
    asRecord(project?.policy) ??
    asRecord(project?.capturePolicy) ??
    asRecord(captureConfig?.policy);
  const settings =
    asRecord(root.settings) ??
    asRecord(project?.settings) ??
    asRecord(project?.captureSettings) ??
    asRecord(root.captureSettings) ??
    asRecord(captureConfig?.settings) ??
    captureConfig;
  const merged = {
    ...root,
    ...project,
    ...captureConfig,
    ...policy,
    ...settings,
  };
  return hasRecognizedRemotePolicy(merged) ? merged : undefined;
}

/**
 * Read the probes a config poll asked to run.
 *
 * This is the one remote field that causes code to run rather than a number to change, so it is
 * read far more strictly than the rest of the policy envelope:
 *
 * - **Names only.** Every entry must be a plain string. One entry shaped as an object refuses the
 *   whole field, rather than being reduced to whatever string could be salvaged from it. An object
 *   carrying a `selector`, `url`, `path` or `expression` is not a malformed probe request, it is a
 *   request for a different mechanism than the one that exists, and answering part of it would be
 *   the beginning of a parameterised probe.
 * - **Allowlisted.** A name that is not in `PROBE_NAMES` is dropped in silence. There is no
 *   normalization, no trimming and no case folding, so nothing can be massaged onto the list.
 * - **Bounded.** At most {@link MAX_REMOTE_PROBES} run per poll, and a list longer than
 *   {@link MAX_REMOTE_PROBE_ENTRIES} is refused before it is scanned.
 * - **Deduplicated**, so a repeated name cannot spend the budget four times over.
 */
function readRemoteProbeNames(settings: Record<string, unknown>): ProbeName[] {
  const raw = settings.probes;
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_REMOTE_PROBE_ENTRIES) return [];
  if (raw.some((entry) => typeof entry !== "string")) return [];

  const accepted: ProbeName[] = [];
  for (const entry of raw) {
    if (!isProbeName(entry)) continue;
    if (accepted.includes(entry)) continue;
    accepted.push(entry);
    if (accepted.length === MAX_REMOTE_PROBES) break;
  }
  return accepted;
}

function applyRemoteConsentMode(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const consent = asRecord(settings.consent);
  const consentMode = consent?.mode ?? settings.consentMode;
  if (consentMode === "implicit" || consentMode === "required")
    config.consentMode = consentMode;
  if (typeof settings.respectGpc === "boolean")
    config.respectGpc = settings.respectGpc;
}

function applyRemoteMaskingMode(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const masking = asRecord(settings.masking) ?? asRecord(settings.privacy);
  const mode =
    readString(masking?.mode) ??
    readString(settings.maskingMode) ??
    (typeof settings.masking === "string" ? settings.masking : undefined);
  if (mode) {
    switch (mode.toLowerCase()) {
      case "all":
      case "full":
      case "mask_all":
      case "strict":
      case "masked":
        config.maskAllText = true;
        config.maskAllInputs = true;
        break;
      case "text":
      case "text_only":
        config.maskAllText = true;
        break;
      case "inputs":
      case "inputs_only":
        config.maskAllInputs = true;
        break;
      case "none":
      case "off":
      case "unmasked":
        // Remote policy may tighten masking only.
        break;
    }
  }
  if (masking?.maskAllText === true) config.maskAllText = true;
  if (masking?.maskAllInputs === true) config.maskAllInputs = true;
}

function readLocalCaptureFloor(config: CrumbtrailConfig): LocalCaptureFloor {
  const sizeLimits = {} as Record<RemoteSizeLimitKey, number>;
  for (const key of REMOTE_SIZE_LIMIT_KEYS) sizeLimits[key] = config[key];
  const collectors = {} as Record<RemoteCollectorKey, boolean>;
  for (const key of REMOTE_COLLECTOR_KEYS)
    collectors[key] = config[key] === true;
  return {
    networkMaxBodySize: config.networkMaxBodySize,
    networkExcludeUrls: [...config.networkExcludeUrls],
    networkCaptureHeaders: config.networkCaptureHeaders,
    redactionMode: config.redaction?.mode ?? "structured",
    redactionDenyFields: [...(config.redaction?.denyFields ?? [])],
    sizeLimits,
    ringBufferMs: config.ringBufferMs,
    ringBufferMaxEvents: config.ringBufferMaxEvents,
    collectors,
  };
}

/**
 * Apply the collector on/off switches a policy carries, and report which ones changed.
 *
 * Tighten-only, like every other field the poll can move. `false` always applies. `true` applies
 * only to a collector the application itself turned on at `init()`, which makes it a restore of
 * something an earlier poll switched off rather than a new capture surface. A `true` for a
 * collector the application left off — keystrokes, clipboard, cookies — is a no-op: an
 * unauthenticated response body must not be able to start capturing data the host never asked
 * for.
 *
 * Every collector switch routes through here so the live start/stop has one place to hook from:
 * the returned keys are exactly the collectors whose effective value moved on this poll, and
 * {@link Crumbtrail.applyRemoteCollectorChanges} turns them into teardowns and installs.
 */
function applyRemoteCollectorSwitches(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
  floor: LocalCaptureFloor,
): RemoteCollectorKey[] {
  const collectors = asRecord(settings.collectors);
  if (!collectors) return [];
  const changed: RemoteCollectorKey[] = [];
  for (const key of REMOTE_COLLECTOR_KEYS) {
    const value = collectors[key];
    if (typeof value !== "boolean" || config[key] === value) continue;
    if (value && !floor.collectors[key]) continue;
    Object.assign(config, { [key]: value });
    changed.push(key);
  }
  return changed;
}

/**
 * Apply the size caps a policy carries, each as `min(remote, init)`. A value above the init one
 * leaves the init one standing, and the comparison is always against the init value so a
 * sequence of polls cannot walk a cap back up one step at a time.
 */
function applyRemoteSizeLimits(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
  floor: LocalCaptureFloor,
): void {
  for (const key of REMOTE_SIZE_LIMIT_KEYS) {
    const value = readDuration(settings[key]);
    if (value === undefined) continue;
    Object.assign(config, { [key]: Math.min(value, floor.sizeLimits[key]) });
  }
}

/**
 * The remote `ringBufferMs`, validated. A retention window is a whole number of milliseconds at
 * or above {@link MIN_REMOTE_RING_BUFFER_MS}; anything else is refused rather than coerced.
 */
function readRemoteRingBufferMs(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_REMOTE_RING_BUFFER_MS
    ? value
    : undefined;
}

/**
 * The remote `ringBufferMaxEvents`, validated.
 *
 * A count of events is an integer of at least one: `0` is a buffer that holds nothing, `0.5` is
 * not a count, and `9e15` is not a cap. {@link EventBus.setMaxBufferedEvents} already refuses
 * anything at or below zero, so a value only the buffer accepted would leave the bus and the
 * buffer holding different ceilings on the same events.
 */
function readRemoteRingBufferMaxEvents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

/**
 * Apply the network capture limits a policy carries. Every one of them tightens only:
 *
 * - `maxBodySize` may lower the local ceiling, never raise it. A remote policy cannot make an
 *   application store more of a request body than its own init block agreed to.
 * - `excludeUrls` are added to the local list. Remote cannot drop a local exclusion, which is
 *   how an application keeps its own endpoints out of capture regardless of policy.
 * - `captureHeaders` may only turn header capture off. The config field is a single boolean
 *   rather than a header allowlist, so "intersect with local" is the boolean AND of the two.
 */
function applyRemoteNetworkLimits(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
  floor: LocalCaptureFloor,
): void {
  const network = asRecord(settings.network);
  const maxBodySize =
    readDuration(network?.maxBodySize) ??
    readDuration(settings.networkMaxBodySize);
  if (maxBodySize !== undefined)
    config.networkMaxBodySize = Math.min(maxBodySize, floor.networkMaxBodySize);

  const excludeUrls =
    readStringList(network?.excludeUrls) ??
    readStringList(settings.networkExcludeUrls);
  if (excludeUrls !== undefined)
    config.networkExcludeUrls = [
      ...new Set([...floor.networkExcludeUrls, ...excludeUrls]),
    ];

  const captureHeaders =
    typeof network?.captureHeaders === "boolean"
      ? network.captureHeaders
      : typeof settings.networkCaptureHeaders === "boolean"
        ? settings.networkCaptureHeaders
        : undefined;
  if (captureHeaders !== undefined)
    config.networkCaptureHeaders =
      floor.networkCaptureHeaders && captureHeaders;
}

/**
 * Apply the redaction policy a policy carries, tighten-only in the same way as
 * {@link applyRemoteMaskingMode}:
 *
 * - `denyFields` are added to the local deny list; a local entry can never be removed.
 * - `mode` may move `"structured"` to `"full"`, never back. Local `"full"` stays `"full"`.
 * - `captureInputValues` may only be turned off.
 * - `keepFields` are ignored outright. A keep exempts a field from the deny rules, so honouring
 *   one from a remote policy would be a response body widening what an application captures.
 *
 * `captureInputValues` is enforced by a module-level flag in `redaction.ts`, because the input
 * redaction path is reached from places that never see a config object. Writing the config field
 * alone would leave the flag at its init value and the tighten would be a silent no-op, so the
 * flag is re-synced here from the value the config now holds.
 */
function applyRemoteRedaction(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
  floor: LocalCaptureFloor,
): void {
  const redaction = asRecord(settings.redaction);
  if (!redaction) return;

  const denyFields = readStringList(redaction.denyFields);
  const mode = readString(redaction.mode);
  const captureInputValues = redaction.captureInputValues;
  const next = { ...config.redaction };

  if (denyFields !== undefined)
    next.denyFields = [
      ...new Set([...floor.redactionDenyFields, ...denyFields]),
    ];
  if (mode === "full" || floor.redactionMode === "full") next.mode = "full";
  if (captureInputValues === false) next.captureInputValues = false;

  config.redaction = next;
  setCaptureInputValues(next.captureInputValues);
}

function applyRemoteSampling(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const sampling = asRecord(settings.sampling);
  const captureRate =
    readRate(sampling?.captureSampleRate) ??
    readRate(sampling?.captureRate) ??
    readRate(sampling?.rate) ??
    readRate(settings.captureSampleRate) ??
    readRate(settings.captureRate) ??
    readRate(settings.sampleRate);
  const baselineRate =
    readRate(sampling?.baselineSampleRate) ??
    readRate(sampling?.baselineRate) ??
    readRate(settings.baselineSampleRate) ??
    readRate(settings.baselineRate);
  if (captureRate !== undefined) config.captureSampleRate = captureRate;
  if (baselineRate !== undefined) config.baselineSampleRate = baselineRate;
}

function applyRemoteTailDuration(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const recorder = asRecord(settings.flightRecorder);
  const tail = asRecord(settings.tail);
  const triggers = asRecord(settings.triggers);
  const tailDuration =
    readSeconds(triggers?.tailSeconds) ??
    readDuration(settings.tailDurationMs) ??
    readDuration(settings.tailMs) ??
    readDuration(recorder?.tailDurationMs) ??
    readDuration(recorder?.tailMs) ??
    readDuration(tail?.durationMs) ??
    readDuration(tail?.ms);
  if (tailDuration !== undefined) config.flightRecorderTailMs = tailDuration;
}

function applyRemoteTriggerSwitches(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): boolean {
  const triggers = asRecord(settings.triggers);
  if (!triggers) return false;
  let changed = false;
  const assign = (key: keyof CrumbtrailConfig, value: unknown) => {
    if (typeof value !== "boolean" || config[key] === value) return;
    Object.assign(config, { [key]: value });
    changed = true;
  };

  const error = triggerSwitch(
    triggers.error ?? triggers.errors ?? triggers.onError,
  );
  const uncaughtError = triggerSwitch(triggers.uncaughtError);
  const unhandledRejection = triggerSwitch(triggers.unhandledRejection);
  const request5xx = triggerSwitch(triggers.request5xx);
  const renderedError = triggerSwitch(
    triggers.renderedError ??
      triggers.renderedErrors ??
      triggers.onRenderedError,
  );
  const caughtError = triggerSwitch(
    triggers.caughtError ?? triggers.caughtErrors ?? triggers.onCaughtError,
  );
  const responseBodyError = triggerSwitch(
    triggers.responseBodyError ??
      triggers.responseBodyErrors ??
      triggers.onResponseBodyError,
  );
  const streamFailure = triggerSwitch(
    triggers.streamFailure ??
      triggers.streamFailures ??
      triggers.onStreamFailure,
  );
  const workerError = triggerSwitch(
    triggers.workerError ?? triggers.workerErrors ?? triggers.onWorkerError,
  );
  const wrongNumber = triggerSwitch(
    triggers.wrongNumber ?? triggers.wrongNumbers ?? triggers.onWrongNumber,
  );
  const resourceLoadFailure = triggerSwitch(
    triggers.resourceLoadFailure ??
      triggers.resourceLoadFailures ??
      triggers.onResourceLoadFailure,
  );
  const storageFailure = triggerSwitch(
    triggers.storageFailure ??
      triggers.storageFailures ??
      triggers.onStorageFailure,
  );
  const explicitBeacon = triggerSwitch(triggers.explicitBeacon);
  const serverSidePull = triggerSwitch(triggers.serverSidePull);
  const maskAll = triggerSwitch(triggers.mask_all);
  if (uncaughtError !== undefined || unhandledRejection !== undefined) {
    assign("autoFlagOnUncaughtError", uncaughtError ?? false);
    assign("autoFlagOnUnhandledRejection", unhandledRejection ?? false);
    assign(
      "autoFlagOnError",
      uncaughtError === true || unhandledRejection === true,
    );
  }
  assign("autoFlagOnRequest5xx", request5xx);
  assign("autoFlagOnRenderedError", renderedError);
  assign("autoFlagOnCaughtError", caughtError);
  assign("autoFlagOnResponseBodyError", responseBodyError);
  assign("autoFlagOnStreamFailure", streamFailure);
  assign("autoFlagOnWorkerError", workerError);
  assign("autoFlagOnWrongNumber", wrongNumber);
  assign("autoFlagOnResourceLoadFailure", resourceLoadFailure);
  assign("autoFlagOnStorageFailure", storageFailure);
  assign("explicitBeacon", explicitBeacon);
  assign("serverSidePull", serverSidePull);
  if (maskAll === true) {
    config.maskAllText = true;
    config.maskAllInputs = true;
  }
  const signals = triggerSwitch(triggers.signals ?? triggers.onSignals);
  const rageClick = triggerSwitch(
    triggers.rageClick ?? triggers.rageClicks ?? triggers.onRageClick,
  );
  const retryStorm = triggerSwitch(
    triggers.retryStorm ?? triggers.retryStorms ?? triggers.onRetryStorm,
  );
  const slowResponse = triggerSwitch(
    triggers.slowResponse ?? triggers.slowResponses ?? triggers.onSlowResponse,
  );
  const abandonedFlow = triggerSwitch(
    triggers.abandonedFlow ??
      triggers.abandonedFlows ??
      triggers.onAbandonedFlow,
  );
  assign("autoFlagOnError", error);
  assign("autoFlagOnSignals", signals);
  assign("autoFlagOnRageClick", rageClick);
  assign("autoFlagOnRetryStorm", retryStorm);
  assign("autoFlagOnSlowResponse", slowResponse);
  assign("autoFlagOnAbandonedFlow", abandonedFlow);

  const behavioralSwitches = [
    rageClick,
    retryStorm,
    slowResponse,
    abandonedFlow,
  ];
  if (
    signals === undefined &&
    behavioralSwitches.some((value) => value !== undefined)
  )
    assign(
      "autoFlagOnSignals",
      behavioralSwitches.some((value) => value === true),
    );
  return changed;
}

function hasRemoteCaptureTrigger(settings: Record<string, unknown>): boolean {
  const triggers = asRecord(settings.triggers);
  return (
    settings.trigger === true ||
    settings.triggerCapture === true ||
    triggers?.trigger === true ||
    triggers?.capture === true
  );
}

function readRate(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A list of non-empty strings, or nothing. One non-string entry refuses the whole field rather
 * than salvaging the strings around it: a half-read exclusion list is a list that captures more
 * than the policy asked for.
 */
function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_REMOTE_STRING_LIST_ENTRIES) return undefined;
  if (value.some((entry) => typeof entry !== "string")) return undefined;
  return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readSeconds(value: unknown): number | undefined {
  const seconds = readDuration(value);
  return seconds === undefined ? undefined : seconds * 1_000;
}

function triggerSwitch(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const nested = asRecord(value);
  return typeof nested?.enabled === "boolean" ? nested.enabled : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRemoteConfigValue(
  key: (typeof REMOTE_CONFIG_KEYS)[number],
  value: unknown,
): value is boolean | number {
  if (
    key === "flightRecorder" ||
    key === "reportScreenshotsEnabled" ||
    key === "autoFlagOnError" ||
    key === "autoFlagOnUncaughtError" ||
    key === "autoFlagOnUnhandledRejection" ||
    key === "autoFlagOnRequest5xx" ||
    key === "autoFlagOnRenderedError" ||
    key === "autoFlagOnCaughtError" ||
    key === "autoFlagOnResponseBodyError" ||
    key === "autoFlagOnStreamFailure" ||
    key === "autoFlagOnWorkerError" ||
    key === "autoFlagOnWrongNumber" ||
    key === "autoFlagOnResourceLoadFailure" ||
    key === "autoFlagOnStorageFailure" ||
    key === "explicitBeacon" ||
    key === "serverSidePull" ||
    key === "autoFlagOnSignals" ||
    key === "autoFlagOnRageClick" ||
    key === "autoFlagOnRetryStorm" ||
    key === "autoFlagOnSlowResponse" ||
    key === "autoFlagOnAbandonedFlow"
  )
    return typeof value === "boolean";
  if (key === "captureSampleRate" || key === "baselineSampleRate")
    return typeof value === "number" && value >= 0 && value <= 1;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTriggerConfigKey(key: (typeof REMOTE_CONFIG_KEYS)[number]): boolean {
  return (
    key === "flightRecorder" ||
    key === "autoFlagOnError" ||
    key === "autoFlagOnRenderedError" ||
    key === "autoFlagOnCaughtError" ||
    key === "autoFlagOnResponseBodyError" ||
    key === "autoFlagOnStreamFailure" ||
    key === "autoFlagOnWorkerError" ||
    key === "autoFlagOnWrongNumber" ||
    key === "autoFlagOnResourceLoadFailure" ||
    key === "autoFlagOnStorageFailure" ||
    key === "autoFlagOnSignals" ||
    key === "autoFlagOnRageClick" ||
    key === "autoFlagOnRetryStorm" ||
    key === "autoFlagOnSlowResponse" ||
    key === "autoFlagOnAbandonedFlow" ||
    key === "autoFlagDebounceMs" ||
    key === "autoFlagMaxPerSession" ||
    key === "rageClickThreshold" ||
    key === "rageClickWindowMs" ||
    key === "retryStormThreshold" ||
    key === "retryStormWindowMs" ||
    key === "retryStormFailThreshold" ||
    key === "slowRequestMs" ||
    key === "slowRequestCount" ||
    key === "slowRequestWindowMs" ||
    key === "abandonedFlowWindowMs" ||
    key === "abandonedFlowMinInputs"
  );
}

function hasRecognizedRemotePolicy(settings: Record<string, unknown>): boolean {
  if (typeof settings.killSwitch === "boolean") return true;
  if (
    settings.consentMode === "implicit" ||
    settings.consentMode === "required"
  )
    return true;
  if (typeof settings.respectGpc === "boolean") return true;
  if (hasRecognizedRemoteMasking(settings)) return true;
  if (hasRecognizedRemoteSampling(settings)) return true;
  if (hasRecognizedRemoteCaptureSettings(settings)) return true;
  // `probes` is deliberately not one of these. Recognizing a policy is what sets
  // `remotePolicyReady`, which is what unblocks capture, so a response carrying nothing but a
  // probe request must not be able to grant itself the readiness its own results then ride on.
  // A probe request is honoured on a poll that also carried a real policy field, and dropped on
  // one that did not.
  return hasRecognizedRemoteTriggers(settings);
}

function hasRecognizedRemoteMasking(
  settings: Record<string, unknown>,
): boolean {
  const masking = asRecord(settings.masking) ?? asRecord(settings.privacy);
  const mode =
    readString(masking?.mode) ??
    readString(settings.maskingMode) ??
    (typeof settings.masking === "string" ? settings.masking : undefined);
  return (
    (mode !== undefined &&
      [
        "all",
        "full",
        "mask_all",
        "strict",
        "masked",
        "text",
        "text_only",
        "inputs",
        "inputs_only",
      ].includes(mode.toLowerCase())) ||
    masking?.maskAllText === true ||
    masking?.maskAllInputs === true
  );
}

/**
 * Collector switches, network limits, redaction and the plain throttles. Recognized the same way
 * as the older policy fields: a response carrying one of them is a policy, so it opens the
 * capture gate rather than leaving the client waiting for the fallback timer.
 */
function hasRecognizedRemoteCaptureSettings(
  settings: Record<string, unknown>,
): boolean {
  if (typeof settings.reportScreenshotsEnabled === "boolean") return true;
  const collectors = asRecord(settings.collectors);
  if (
    collectors &&
    REMOTE_COLLECTOR_KEYS.some((key) => typeof collectors[key] === "boolean")
  )
    return true;

  const network = asRecord(settings.network);
  if (
    readDuration(network?.maxBodySize) !== undefined ||
    readDuration(settings.networkMaxBodySize) !== undefined ||
    readStringList(network?.excludeUrls) !== undefined ||
    readStringList(settings.networkExcludeUrls) !== undefined ||
    typeof network?.captureHeaders === "boolean" ||
    typeof settings.networkCaptureHeaders === "boolean"
  )
    return true;

  const redaction = asRecord(settings.redaction);
  if (
    redaction &&
    (readStringList(redaction.denyFields) !== undefined ||
      readString(redaction.mode) !== undefined ||
      typeof redaction.captureInputValues === "boolean")
  )
    return true;

  if (
    REMOTE_THROTTLE_KEYS.some(
      (key) => isRemoteConfigValue(key, settings[key]) === true,
    )
  )
    return true;

  if (
    REMOTE_SIZE_LIMIT_KEYS.some(
      (key) => readDuration(settings[key]) !== undefined,
    )
  )
    return true;

  return (
    readRemoteRingBufferMs(settings.ringBufferMs) !== undefined ||
    readRemoteRingBufferMaxEvents(settings.ringBufferMaxEvents) !== undefined
  );
}

function hasRecognizedRemoteSampling(
  settings: Record<string, unknown>,
): boolean {
  const sampling = asRecord(settings.sampling);
  return [
    sampling?.captureSampleRate,
    sampling?.captureRate,
    sampling?.rate,
    sampling?.baselineSampleRate,
    sampling?.baselineRate,
    settings.captureSampleRate,
    settings.captureRate,
    settings.sampleRate,
    settings.baselineSampleRate,
    settings.baselineRate,
  ].some((value) => readRate(value) !== undefined);
}

function hasRecognizedRemoteTriggers(
  settings: Record<string, unknown>,
): boolean {
  const triggers = asRecord(settings.triggers);
  if (!triggers) return false;
  return [
    triggers.tailSeconds,
    triggers.uncaughtError,
    triggers.unhandledRejection,
    triggers.request5xx,
    triggers.renderedError,
    triggers.renderedErrors,
    triggers.onRenderedError,
    triggers.caughtError,
    triggers.caughtErrors,
    triggers.onCaughtError,
    triggers.responseBodyError,
    triggers.responseBodyErrors,
    triggers.onResponseBodyError,
    triggers.streamFailure,
    triggers.streamFailures,
    triggers.onStreamFailure,
    triggers.workerError,
    triggers.workerErrors,
    triggers.onWorkerError,
    triggers.wrongNumber,
    triggers.wrongNumbers,
    triggers.onWrongNumber,
    triggers.resourceLoadFailure,
    triggers.resourceLoadFailures,
    triggers.onResourceLoadFailure,
    triggers.storageFailure,
    triggers.storageFailures,
    triggers.onStorageFailure,
    triggers.explicitBeacon,
    triggers.serverSidePull,
    triggers.mask_all,
    triggers.error,
    triggers.errors,
    triggers.onError,
    triggers.signals,
    triggers.onSignals,
    triggers.rageClick,
    triggers.rageClicks,
    triggers.onRageClick,
    triggers.retryStorm,
    triggers.retryStorms,
    triggers.onRetryStorm,
    triggers.slowResponse,
    triggers.slowResponses,
    triggers.onSlowResponse,
    triggers.abandonedFlow,
    triggers.abandonedFlows,
    triggers.onAbandonedFlow,
  ].some(
    (value) =>
      triggerSwitch(value) !== undefined || readDuration(value) !== undefined,
  );
}

function redactDatabaseEventValues(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (
    type !== "db.diff" &&
    type !== "db.read" &&
    type !== "db.diff.bulk" &&
    type !== "db.read.bulk" &&
    type !== "db.statement" &&
    type !== "db.error" &&
    type !== "db.transaction"
  )
    return data;
  const output = { ...data };
  for (const key of [
    "pk",
    "after",
    "before",
    "row",
    "samplePks",
    "sampleValues",
    "values",
  ]) {
    if (key in output) output[key] = maskDatabaseValue(output[key]);
  }
  if ("connection" in output) {
    const connection = asRecord(output.connection);
    output.connection = connection
      ? {
          ...(connection.host !== undefined
            ? { host: maskDatabaseValue(connection.host) }
            : {}),
          ...(connection.database !== undefined
            ? { database: maskDatabaseValue(connection.database) }
            : {}),
          ...(connection.role === "primary" || connection.role === "replica"
            ? { role: connection.role }
            : {}),
        }
      : maskDatabaseValue(output.connection);
  }
  return output;
}

function maskDatabaseValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return maskText(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return REDACTED_VALUE;
  if (Array.isArray(value)) return value.map(maskDatabaseValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        maskDatabaseValue(entry),
      ]),
    );
  return REDACTED_VALUE;
}
