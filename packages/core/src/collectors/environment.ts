import type { EventBus } from "../event-bus";
import type {
  CrumbtrailConfig,
  CollectorCleanup,
  CollectorContext,
  EnvSnapshot,
} from "../types";
import { redactValue, type RedactionMetadata } from "../redaction";
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
  _config: CrumbtrailConfig,
  context: CollectorContext,
): CollectorCleanup {
  const declared = context.getDeclaredEnv?.() ?? {};
  const snapshot = buildEnvSnapshot(declared.flags, declared.config);

  bus.emit({
    t: now(),
    k: "env",
    d: snapshot as unknown as Record<string, unknown>,
  });
  context.onEnvEmitted?.();

  return () => {};
}

/** Builds the redaction-aware snapshot payload. Exported for direct unit testing. */
export function buildEnvSnapshot(
  flags?: Record<string, unknown>,
  config?: Record<string, unknown>,
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

  applyDeclaredEnv(snapshot, flags, config);

  return snapshot;
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
    target.redaction = mergeMetadata(metadataItems);
  }
}

function mergeMetadata(items: RedactionMetadata[]): RedactionMetadata {
  return {
    policy: items[0].policy,
    fields: items.flatMap((item) => item.fields),
  };
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
