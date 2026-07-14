import { EventBus } from "./event-bus";
import { RingBuffer } from "./ring-buffer";
import type {
  AddBugEventOptions,
  BugEvent,
  CrumbtrailConfig,
  CrumbtrailPreset,
  CrumbtrailTransport,
  BugReport,
  CollectorCleanup,
  CollectorContext,
  FlagBugOptions,
} from "./types";
import {
  DEFAULT_CONFIG,
  PRESET_FULL,
  PRESET_LIGHT,
  PRESET_PASSIVE,
} from "./types";
import { createCrumbtrailRequestHeaders } from "./correlation";
import { createAutoFlagController } from "./auto-flag";
import {
  errorDetector,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
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
  createWebSessionStore,
  DEFAULT_SESSION_STORAGE_KEY,
  type SessionStore,
} from "./session-store";
import { consoleCollector } from "./collectors/console";
import { errorCollector } from "./collectors/error";
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
import { environmentCollector, buildEnvDelta } from "./collectors/environment";
import type { EnvDeclaration } from "./types";
import {
  attachRedactionMetadata,
  redactNetworkTextBody,
  redactValue,
  type PayloadSummary,
} from "./redaction";

type Collector = (
  bus: EventBus,
  config: CrumbtrailConfig,
  context: CollectorContext,
) => CollectorCleanup;

const COLLECTOR_MAP: Record<string, Collector> = {
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
};

const SESSION_STORAGE_KEY = DEFAULT_SESSION_STORAGE_KEY;

/**
 * Minimum spacing between severity-triggered flushes. An error storm must not
 * become a request storm: the first severe event flushes immediately, the
 * rest ride the next interval flush. Only tap-triggered flushes are
 * rate-limited — interval, buffer-size, flagBug, stop, and resume flushes are
 * never affected.
 */
const SEVERITY_FLUSH_MIN_INTERVAL_MS = 1000;

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
): string | undefined {
  const persisted = store.read();
  if (!persisted) return undefined;
  if (now() - persisted.lastActivity > idleMs) return undefined; // stale -> mint a fresh session
  return persisted.id;
}

function writePersistedSession(store: SessionStore, id: string): void {
  store.write({ id, lastActivity: now() });
}

export class Crumbtrail {
  private bus: EventBus;
  private transport: CrumbtrailTransport;
  private ringBuffer: RingBuffer;
  private cleanups: CollectorCleanup[] = [];
  private config: CrumbtrailConfig;
  private sessionId: string;
  private widgetCleanup?: () => void;
  private stateProviders = new Map<string, () => unknown>();
  private declaredFlags: Record<string, unknown> = {};
  private declaredConfig: Record<string, unknown> = {};
  private envEmitted = false;

  private constructor(
    config: CrumbtrailConfig,
    bus: EventBus,
    transport: CrumbtrailTransport,
    ringBuffer: RingBuffer,
    sessionId: string,
  ) {
    this.config = config;
    this.bus = bus;
    this.transport = transport;
    this.ringBuffer = ringBuffer;
    this.sessionId = sessionId;
  }

  static init(
    presetOrConfig?: CrumbtrailPreset | Partial<CrumbtrailConfig>,
  ): Crumbtrail {
    const overrides =
      typeof presetOrConfig === "string"
        ? PRESETS[presetOrConfig]
        : presetOrConfig;
    const config = { ...DEFAULT_CONFIG, ...overrides };

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
      );
    }

    const sessionStore =
      config.sessionPersistence === "session"
        ? (config.sessionStore ?? createWebSessionStore())
        : undefined;
    const useSessionStore = Boolean(sessionStore);
    // Reuse a persisted session id across a hard page reload (same tab, within the idle window)
    // so a reload appends to the same session instead of spawning a new one. Explicit sessionId
    // always wins; SSR / non-browser falls through to a fresh id.
    const sessionId =
      config.sessionId ??
      (sessionStore
        ? readPersistedSessionId(sessionStore, config.sessionIdleMs)
        : undefined) ??
      generateSessionId();
    if (sessionStore) writePersistedSession(sessionStore, sessionId);
    const bus = new EventBus();
    const ringBuffer = new RingBuffer(
      config.ringBufferMs,
      config.ringBufferMaxEvents,
    );

    const transport: CrumbtrailTransport =
      config.transportInstance ??
      new HttpTransport(config.httpEndpoint, {
        authToken: config.httpAuthToken,
      });

    // Send events to transport
    bus.subscribe((events) => {
      transport.sendEvents(events).catch(() => {});
    });

    // Feed events into ring buffer
    bus.subscribe((events) => {
      ringBuffer.pushBatch(events);
    });

    // Refresh the persisted session's lastActivity as events flow, so an active session keeps
    // its rolling idle window alive across reloads.
    if (useSessionStore && sessionStore) {
      bus.subscribe(() => {
        writePersistedSession(sessionStore, sessionId);
      });
    }

    bus.start(config.flushIntervalMs, config.flushBufferSize);

    const instance = new Crumbtrail(
      config,
      bus,
      transport,
      ringBuffer,
      sessionId,
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

    // Last-chance flush on page teardown. `pagehide` is the most reliable
    // end-of-life signal across browsers (tab close, navigation, bfcache
    // entry); the transport's keepalive/sendBeacon path then gives the batch a
    // real chance to leave the page. Guarded because a caller-supplied
    // `transportInstance` lets init() run without a window (SSR/programmatic).
    if (typeof window !== "undefined") {
      const flushOnPageHide = () => bus.flush();
      window.addEventListener("pagehide", flushOnPageHide);
      instance.cleanups.push(() =>
        window.removeEventListener("pagehide", flushOnPageHide),
      );
    }

    const collectorContext: CollectorContext = {
      sessionId,
      getDeclaredEnv: () => ({
        flags: instance.declaredFlags,
        config: instance.declaredConfig,
      }),
      onEnvEmitted: () => {
        instance.envEmitted = true;
      },
      registerStateProvider: (name, provider) =>
        instance.registerStateProvider(name, provider),
    };

    const autoFlagDetectors: SignalDetector[] = [];
    if (config.autoFlagOnError) autoFlagDetectors.push(errorDetector());
    if (config.autoFlagOnSignals) {
      autoFlagDetectors.push(
        rageClickDetector({
          threshold: config.rageClickThreshold,
          windowMs: config.rageClickWindowMs,
        }),
        retryStormDetector({
          threshold: config.retryStormThreshold,
          windowMs: config.retryStormWindowMs,
          failThreshold: config.retryStormFailThreshold,
        }),
        slowResponseDetector({
          thresholdMs: config.slowRequestMs,
          count: config.slowRequestCount,
          windowMs: config.slowRequestWindowMs,
        }),
        abandonedFlowDetector({
          windowMs: config.abandonedFlowWindowMs,
          minInputs: config.abandonedFlowMinInputs,
        }),
      );
    }
    if (autoFlagDetectors.length > 0) {
      const autoFlag = createAutoFlagController({
        debounceMs: config.autoFlagDebounceMs,
        maxPerSession: config.autoFlagMaxPerSession,
        flag: (options) => instance.flagBug(options),
        detectors: autoFlagDetectors,
      });
      instance.cleanups.push(bus.tap((event) => autoFlag.handleEvent(event)));
      instance.cleanups.push(() => autoFlag.dispose());
    }

    // Fire and forget — don't block init on network
    transport
      .startSession(sessionId, {
        url: typeof location !== "undefined" ? location.href : "",
        ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
      })
      .catch(() => {});

    for (const [key, collector] of Object.entries(COLLECTOR_MAP)) {
      if (config[key as keyof CrumbtrailConfig]) {
        instance.cleanups.push(collector(bus, config, collectorContext));
      }
    }

    // Mount widget if enabled
    if (config.widget && typeof document !== "undefined") {
      import("./widget/bug-widget")
        .then(({ mountWidget }) => {
          instance.widgetCleanup = mountWidget(instance);
        })
        .catch(() => {});
    }

    return instance;
  }

  async flagBug(options?: FlagBugOptions): Promise<{ bugId: string }> {
    const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const windowMs = options?.windowMs ?? this.config.ringBufferMs;
    const flaggedAt = now();

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
        this.bus.emit({
          t: flaggedAt,
          k: "state.snap",
          d,
        });
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
        this.bus.emit({
          t: flaggedAt,
          k: "state.err",
          d,
        });
      }
    }

    // One-shot DOM snapshot: the exact UI at flag time, which the event stream can't reconstruct.
    if (this.config.domSnapshot && typeof document !== "undefined") {
      try {
        const fullHtml = document.documentElement.outerHTML;
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
        this.bus.emit({ t: flaggedAt, k: "dom.snap", d });
      } catch {
        // DOM serialization must never block the report.
      }
    }

    // Emit marker into the live stream and include it in snapshot.
    this.bus.emit({
      t: flaggedAt,
      k: "bug.flag",
      d: { bugId, note: options?.note },
    });

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
      note: options?.note,
      voiceNote: options?.voiceBlob ? "voice.webm" : undefined,
      url: typeof location !== "undefined" ? location.href : "",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
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

    return { bugId };
  }

  mark(label: string): void {
    this.bus.emit({ t: now(), k: "mark", d: { label } });
  }

  addEvent(partial: AddBugEventOptions): void {
    const { type, data, ...envelope } = partial;
    this.bus.emit({ t: now(), k: type, d: data, ...envelope });
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
   * after `init`), it emits a `k:'env'` delta event ({ kind:'delta' }). If called before the
   * snapshot is emitted (e.g. environment collector disabled or not yet run), the values are
   * folded into the snapshot instead.
   */
  setEnv(declaration: EnvDeclaration): void {
    if (declaration.flags) Object.assign(this.declaredFlags, declaration.flags);
    if (declaration.config)
      Object.assign(this.declaredConfig, declaration.config);

    if (!this.envEmitted) return;

    const delta = buildEnvDelta(declaration.flags, declaration.config);
    this.bus.emit({
      t: now(),
      k: "env",
      d: delta as unknown as Record<string, unknown>,
    });
  }

  async stop(): Promise<{ sessionId: string }> {
    if (this.widgetCleanup) this.widgetCleanup();
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.stateProviders.clear();
    this.bus.stop();
    this.ringBuffer.clear();
    await this.transport.endSession(this.sessionId);
    return { sessionId: this.sessionId };
  }
}

/**
 * Error-class events that justify flushing ahead of the batch interval:
 * uncaught errors, unhandled promise rejections, and failed network
 * responses (HTTP >= 400 or an application-failure body).
 */
function isSevereEvent(event: BugEvent): boolean {
  return (
    event.k === "err" || event.k === "rej" || isFailedNetworkResponse(event)
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
