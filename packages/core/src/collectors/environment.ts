import type { EventBus } from "../event-bus";
import type {
  CrumbtrailConfig,
  CollectorCleanup,
  CollectorContext,
  EnvCampaign,
  EnvConnection,
  EnvDevice,
  EnvSnapshot,
} from "../types";
import {
  redactCampaignParams,
  redactUrl,
  redactValue,
  type RedactionMetadata,
} from "../redaction";
import { now } from "../utils";

/**
 * Environment collector. Emits exactly one `k:'env'` snapshot event at session start with a
 * redaction-aware view of the runtime: userAgent/browser/os/viewport (best-effort, browser
 * only) plus locale/timezone (available in Node via `Intl`). Any feature flags / config the
 * app declared via `logger.setEnv` before the snapshot is folded in (redacted). Guarded so it
 * never throws in non-browser/SSR/test runtimes — it degrades to whatever IS available.
 *
 * Out of scope (CP3): privileged enumeration of installed browser extensions (absent in SDK
 * mode) and continuous mid-session env polling beyond this snapshot + `setEnv` deltas.
 */
export function environmentCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
  context: CollectorContext,
): CollectorCleanup {
  const declared = context.getDeclaredEnv?.() ?? {};
  const snapshot = buildEnvSnapshot(declared.flags, declared.config, {
    campaign: config.campaign,
  });

  bus.emit({
    t: now(),
    k: "env",
    d: snapshot as unknown as Record<string, unknown>,
  });
  context.onEnvEmitted?.();

  return () => {};
}

/** Optional snapshot behaviours the caller opts into. Absent means every one is off. */
export interface EnvSnapshotOptions {
  /**
   * Read first-party `utm_*` labels off `location.search`. Off unless the integrator
   * turned `campaign` on, so a two-argument call captures nothing extra.
   */
  campaign?: boolean;
}

/** Builds the redaction-aware snapshot payload. Exported for direct unit testing. */
export function buildEnvSnapshot(
  flags?: Record<string, unknown>,
  config?: Record<string, unknown>,
  options?: EnvSnapshotOptions,
): EnvSnapshot {
  const snapshot: EnvSnapshot = { kind: "snapshot" };

  const ua = safeUserAgent();
  if (ua) {
    snapshot.userAgent = ua;
    const browser = detectBrowser(ua);
    if (browser) snapshot.browser = browser;
    const os = detectOs(ua);
    if (os) snapshot.os = os;
  }

  const viewport = safeViewport();
  if (viewport) snapshot.viewport = viewport;

  const locale = safeLocale();
  if (locale) snapshot.locale = locale;

  const timezone = safeTimezone();
  if (timezone) snapshot.timezone = timezone;

  const appBuild = safeAppBuild();
  if (appBuild) snapshot.appBuild = appBuild;

  // An empty `document.referrer` means there was no referrer. Emitting `""`
  // would instead claim a referrer that happened to be blank, so the key is
  // omitted entirely. The value is redacted with the same `redactUrl` policy a
  // `referrer` request header already gets (see URL_HEADER_NAMES in
  // redaction.ts), so a query string carrying a token is stripped here too.
  const referrer = safeReferrer();
  if (referrer) {
    const result = redactUrl(referrer, "env.referrer");
    snapshot.referrer = result.value;
    if (result.metadata) addRedactionMetadata(snapshot, result.metadata);
  }

  // Off unless the integrator asked for it. `DEFAULT_CONFIG.campaign` is `false`,
  // so the default build never reads the entry URL's query string at all.
  if (options?.campaign === true) applyCampaign(snapshot);

  const device = safeDevice();
  if (device) snapshot.device = device;

  const connection = safeConnection();
  if (connection) snapshot.connection = connection;

  const deviceMemory = safeNavigatorNumber("deviceMemory");
  if (deviceMemory !== undefined) snapshot.deviceMemory = deviceMemory;

  const hardwareConcurrency = safeNavigatorNumber("hardwareConcurrency");
  if (hardwareConcurrency !== undefined)
    snapshot.hardwareConcurrency = hardwareConcurrency;

  applyDeclaredEnv(snapshot, flags, config);

  return snapshot;
}

/**
 * The only mapping between the wire parameter names and the snapshot's field
 * names. Every key here is a literal `utm_*` name that `redactCampaignParams`
 * already allows, so nothing outside that allowlist has a field to land in even
 * if the redaction layer ever returned one.
 */
const CAMPAIGN_FIELD_BY_PARAM: Record<string, keyof EnvCampaign> = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaign",
  utm_term: "term",
  utm_content: "content",
};

/**
 * Reads first-party campaign labels off the entry URL through the campaign
 * allowlist in `redaction.ts`. Cross-site click identifiers (`gclid`, `fbclid`,
 * `msclkid`, `ttclid` and family) are not readable through that function and are
 * not readable here either — this code never touches `location.search` except
 * through it.
 *
 * The `campaign` key is omitted when no label survived, so an enabled build on a
 * page with no `utm_*` looks exactly like a disabled one. Redaction metadata is
 * still merged when the allowlist redacted or dropped something, because that
 * happened whether or not a label came out the other side.
 */
function applyCampaign(snapshot: EnvSnapshot): void {
  const search = safeLocationSearch();
  if (!search) return;

  const result = redactCampaignParams(search);

  const campaign: EnvCampaign = {};
  for (const [param, value] of Object.entries(result.value)) {
    const field = CAMPAIGN_FIELD_BY_PARAM[param];
    if (field) campaign[field] = value;
  }
  if (Object.keys(campaign).length > 0) snapshot.campaign = campaign;

  if (result.metadata) addRedactionMetadata(snapshot, result.metadata);
}

function safeLocationSearch(): string | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    const search: unknown = window.location?.search;
    return typeof search === "string" && search !== "" ? search : undefined;
  } catch {
    // location can throw in sandboxed/cross-origin contexts.
    return undefined;
  }
}

/**
 * Build identifiers stamped into public HTML are release metadata rather than
 * user data. Keep only the conventional token-safe form and bound it tightly.
 */
function safeAppBuild(): string | undefined {
  try {
    if (typeof document === "undefined") return undefined;
    const value = document
      .querySelector('meta[name="app-build"]')
      ?.getAttribute("content")
      ?.trim();
    return value && /^[A-Za-z0-9._-]{1,120}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a `k:'env'` delta payload from a `setEnv` call made after the snapshot was emitted.
 * Values are redacted before they rest. Exported for direct unit testing.
 */
export function buildEnvDelta(
  flags?: Record<string, unknown>,
  config?: Record<string, unknown>,
): EnvSnapshot {
  const delta: EnvSnapshot = { kind: "delta" };
  applyDeclaredEnv(delta, flags, config);
  return delta;
}

function applyDeclaredEnv(
  target: EnvSnapshot,
  flags?: Record<string, unknown>,
  config?: Record<string, unknown>,
): void {
  const metadataItems: RedactionMetadata[] = [];

  if (flags && Object.keys(flags).length > 0) {
    const result = redactValue(flags, "env.flags");
    target.flags = result.value;
    if (result.metadata) metadataItems.push(result.metadata);
  }

  if (config && Object.keys(config).length > 0) {
    const result = redactValue(config, "env.config");
    target.config = result.value;
    if (result.metadata) metadataItems.push(result.metadata);
  }

  if (metadataItems.length > 0) {
    addRedactionMetadata(target, mergeMetadata(metadataItems));
  }
}

/**
 * Folds one more source of redaction metadata into `target.redaction` instead
 * of replacing what is already there. Flags/config are no longer the only
 * source — the referrer redacts too, and later snapshot fields may as well — so
 * every writer goes through here and none of them can drop another's fields.
 */
function addRedactionMetadata(
  target: EnvSnapshot,
  metadata: RedactionMetadata,
): void {
  const existing = target.redaction as RedactionMetadata | undefined;
  target.redaction = existing ? mergeMetadata([existing, metadata]) : metadata;
}

function mergeMetadata(items: RedactionMetadata[]): RedactionMetadata {
  return {
    policy: items[0].policy,
    fields: items.flatMap((item) => item.fields),
  };
}

function safeReferrer(): string | undefined {
  try {
    if (
      typeof document !== "undefined" &&
      typeof document.referrer === "string" &&
      document.referrer.trim() !== ""
    ) {
      return document.referrer;
    }
  } catch {
    // document can throw in sandboxed/SSR contexts.
  }
  return undefined;
}

/**
 * Display characteristics a rendering defect reproduces against. Each read is
 * guarded on its own so a runtime that exposes `screen` without
 * `screen.orientation` still contributes `dpr` and `screen`.
 */
function safeDevice(): EnvDevice | undefined {
  const device: EnvDevice = {};

  try {
    if (
      typeof window !== "undefined" &&
      isFiniteNumber(window.devicePixelRatio)
    )
      device.dpr = window.devicePixelRatio;
  } catch {
    // window may be unavailable outside a browser.
  }

  try {
    const screen = typeof window !== "undefined" ? window.screen : undefined;
    if (screen && isFiniteNumber(screen.width) && isFiniteNumber(screen.height))
      device.screen = { w: screen.width, h: screen.height };
  } catch {
    // screen is absent in non-browser runtimes.
  }

  try {
    // Read as `unknown`: the DOM lib types `type` as a closed literal union,
    // but a real runtime may expose anything (or nothing) here.
    const orientation: unknown =
      typeof window !== "undefined"
        ? window.screen?.orientation?.type
        : undefined;
    if (typeof orientation === "string" && orientation !== "")
      device.orientation = orientation;
  } catch {
    // Screen Orientation API is not universal.
  }

  return Object.keys(device).length > 0 ? device : undefined;
}

/**
 * Network Information API view of the connection. Absent in most runtimes
 * (including happy-dom and every non-Chromium browser), which is a normal
 * result rather than an error: the whole object is omitted.
 */
function safeConnection(): EnvConnection | undefined {
  try {
    if (typeof navigator === "undefined") return undefined;
    const raw = (
      navigator as Navigator & {
        connection?: {
          effectiveType?: unknown;
          downlink?: unknown;
          rtt?: unknown;
          saveData?: unknown;
        };
      }
    ).connection;
    if (!raw || typeof raw !== "object") return undefined;

    const connection: EnvConnection = {};
    if (typeof raw.effectiveType === "string" && raw.effectiveType !== "")
      connection.effectiveType = raw.effectiveType;
    if (isFiniteNumber(raw.downlink)) connection.downlink = raw.downlink;
    if (isFiniteNumber(raw.rtt)) connection.rtt = raw.rtt;
    if (typeof raw.saveData === "boolean") connection.saveData = raw.saveData;

    return Object.keys(connection).length > 0 ? connection : undefined;
  } catch {
    // navigator can throw in sandboxed/SSR contexts.
  }
  return undefined;
}

function safeNavigatorNumber(
  name: "deviceMemory" | "hardwareConcurrency",
): number | undefined {
  try {
    if (typeof navigator === "undefined") return undefined;
    const value = (navigator as Navigator & Record<string, unknown>)[name];
    if (isFiniteNumber(value) && value > 0) return value;
  } catch {
    // navigator can throw in sandboxed/SSR contexts.
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeUserAgent(): string | undefined {
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.userAgent === "string"
    ) {
      return navigator.userAgent;
    }
  } catch {
    // navigator can throw in sandboxed/SSR contexts.
  }
  return undefined;
}

function safeViewport(): { w: number; h: number } | undefined {
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.innerWidth === "number" &&
      typeof window.innerHeight === "number"
    ) {
      return { w: window.innerWidth, h: window.innerHeight };
    }
  } catch {
    // window may be unavailable outside a browser.
  }
  return undefined;
}

function safeLocale(): string | undefined {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Intl is available in Node, but guard defensively anyway.
  }
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.language === "string"
    ) {
      return navigator.language;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function safeTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // ignore
  }
  return undefined;
}

function detectBrowser(
  ua: string,
): { name: string; version?: string } | undefined {
  const tests: Array<{ name: string; re: RegExp }> = [
    { name: "Edge", re: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
    { name: "Opera", re: /OPR\/([\d.]+)/ },
    { name: "Chrome", re: /Chrome\/([\d.]+)/ },
    { name: "Firefox", re: /Firefox\/([\d.]+)/ },
    { name: "Safari", re: /Version\/([\d.]+).*Safari/ },
  ];
  for (const { name, re } of tests) {
    const match = ua.match(re);
    if (match) return match[1] ? { name, version: match[1] } : { name };
  }
  return undefined;
}

function detectOs(ua: string): string | undefined {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}
