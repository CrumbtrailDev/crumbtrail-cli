import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  attachRedactionMetadata,
  redactCookieName,
  redactCookieValue,
} from "../redaction";
import { now } from "../utils";

interface CookieMap {
  [name: string]: string;
}

interface CookieStoreChangeEvent {
  changed: Array<{
    name: string;
    value: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  }>;
  deleted: Array<{ name: string }>;
}

function parseCookies(cookieStr: string): CookieMap {
  const map: CookieMap = {};
  if (!cookieStr) return map;
  const pairs = cookieStr.split(";");
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

function buildFlags(cookie: {
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}): string {
  let flags = "";
  if (cookie.secure) flags += "s";
  if (cookie.httpOnly) flags += "h";
  if (cookie.sameSite) {
    const ss = cookie.sameSite.toLowerCase();
    if (ss === "strict") flags += "S";
    else if (ss === "lax") flags += "L";
    else if (ss === "none") flags += "N";
  }
  return flags;
}

function redactCookieForEvent(
  name: string,
  value: string,
  config: CrumbtrailConfig,
): ReturnType<typeof redactCookieValue> {
  return redactCookieValue(
    name,
    value,
    `cookie.${name}.val`,
    config.cookieMaskNames,
  );
}

function safeCookieName(name: string): string {
  return redactCookieName(name);
}

export function cookieCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  let lastCookies: CookieMap = {};

  // Emit initial cookies
  const initial = parseCookies(document.cookie);
  for (const [name, value] of Object.entries(initial)) {
    const val = redactCookieForEvent(name, value, config);
    const d: Record<string, unknown> = {
      op: "set",
      name: safeCookieName(name),
      val: val.value,
    };
    if (val.summary) d.valSummary = val.summary;
    attachRedactionMetadata(d, val.metadata);
    bus.emit({
      t: now(),
      k: "cookie",
      d,
    });
  }
  lastCookies = { ...initial };

  // Check if CookieStore API is available
  const hasCookieStore =
    typeof (globalThis as Record<string, unknown>).cookieStore !== "undefined";

  if (hasCookieStore) {
    const cs = (globalThis as Record<string, unknown>)
      .cookieStore as EventTarget & Record<string, unknown>;

    const changeHandler = (event: unknown) => {
      const e = event as CookieStoreChangeEvent;

      for (const cookie of e.changed) {
        const val = redactCookieForEvent(cookie.name, cookie.value, config);
        const flags = buildFlags(cookie);
        const d: Record<string, unknown> = {
          op: lastCookies[cookie.name] !== undefined ? "mod" : "set",
          name: safeCookieName(cookie.name),
          val: val.value,
        };
        if (val.summary) d.valSummary = val.summary;
        if (flags) d.flags = flags;
        attachRedactionMetadata(d, val.metadata);
        bus.emit({ t: now(), k: "cookie", d });
        lastCookies[cookie.name] = cookie.value;
      }

      for (const cookie of e.deleted) {
        bus.emit({
          t: now(),
          k: "cookie",
          d: { op: "del", name: safeCookieName(cookie.name) },
        });
        delete lastCookies[cookie.name];
      }
    };

    cs.addEventListener("change", changeHandler as EventListener);

    return () => {
      cs.removeEventListener("change", changeHandler as EventListener);
    };
  }

  // Fallback: poll document.cookie
  const pollInterval = setInterval(() => {
    const current = parseCookies(document.cookie);

    // Detect new and modified cookies
    for (const [name, value] of Object.entries(current)) {
      if (!(name in lastCookies)) {
        const val = redactCookieForEvent(name, value, config);
        const d: Record<string, unknown> = {
          op: "set",
          name: safeCookieName(name),
          val: val.value,
        };
        if (val.summary) d.valSummary = val.summary;
        attachRedactionMetadata(d, val.metadata);
        bus.emit({
          t: now(),
          k: "cookie",
          d,
        });
      } else if (lastCookies[name] !== value) {
        const val = redactCookieForEvent(name, value, config);
        const d: Record<string, unknown> = {
          op: "mod",
          name: safeCookieName(name),
          val: val.value,
        };
        if (val.summary) d.valSummary = val.summary;
        attachRedactionMetadata(d, val.metadata);
        bus.emit({
          t: now(),
          k: "cookie",
          d,
        });
      }
    }

    // Detect deleted cookies
    for (const name of Object.keys(lastCookies)) {
      if (!(name in current)) {
        bus.emit({
          t: now(),
          k: "cookie",
          d: { op: "del", name: safeCookieName(name) },
        });
      }
    }

    lastCookies = { ...current };
  }, config.cookiePollIntervalMs);

  return () => {
    clearInterval(pollInterval);
  };
}
