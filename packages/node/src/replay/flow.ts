import {
  REDACTED_VALUE,
  redactInputValue,
  redactTokenLikeString,
} from "crumbtrail-core";
import { sanitizeSelector } from "../sanitize-selector";
import type { ReplayFlow, ReplayStep, ReplayValueSource } from "./types";

/**
 * Distils the replayable part of a captured session — the `nav` / `clk` / `inp`
 * events emitted by `collectors/interaction.ts` — into an ordered
 * {@link ReplayFlow}.
 *
 * Two safety properties are established here, before any policy runs, so that
 * no later stage can leak them:
 *
 * 1. **Navigations are rebased.** Only the path and its non-credential query
 *    parameters are kept; the captured origin never reaches the driver. The
 *    replay drives `targetUrl`'s origin only.
 * 2. **Credential-like input values are dropped, not carried.** A value from a
 *    password/email/tel/sensitively-named field, or one that `redactInputValue`
 *    classifies as sensitive, is replaced by a `secret` marker that records the
 *    reason. The raw string is never written into the flow.
 */

const NAVIGATE_KIND = "nav";
const CLICK_KIND = "clk";
const INPUT_KIND = "inp";

export interface ReplayFlowEvent {
  k: string;
  d?: Record<string, unknown> | null;
}

export interface BuildReplayFlowInput {
  sourceSessionId: string;
  events: ReplayFlowEvent[];
  /**
   * Base URL the replay would drive. Required: a replay never defaults to the
   * captured (potentially production) origin.
   */
  targetUrl: string;
}

export function buildReplayFlow(input: BuildReplayFlowInput): ReplayFlow {
  const steps: ReplayStep[] = [];
  let capturedOrigin: string | undefined;

  for (const event of input.events) {
    const data = isRecord(event?.d) ? event.d : undefined;
    if (!data) continue;

    if (event.k === NAVIGATE_KIND) {
      const to = asString(data.to);
      if (!to) continue;
      capturedOrigin ??= originOf(to);
      const step = navigationStep(steps.length, to);
      if (step) steps.push(step);
      continue;
    }

    if (event.k === CLICK_KIND || event.k === INPUT_KIND) {
      const el = isRecord(data.el) ? data.el : undefined;
      if (!el) continue;
      const sig = asString(el.sig);
      if (!sig) continue;

      const base: ReplayStep = {
        index: steps.length,
        sig,
        action: event.k === CLICK_KIND ? "click" : "input",
        selector: sanitizeSelector(el.path),
        tag: asString(el.tag)?.toLowerCase(),
        role: roleFor(el),
        label: labelFor(el),
      };

      if (event.k === INPUT_KIND) base.value = classifyValue(data, el);
      steps.push(pruneUndefined(base));
      continue;
    }
  }

  return pruneUndefined({
    sourceSessionId: input.sourceSessionId,
    targetUrl: input.targetUrl,
    capturedOrigin,
    steps,
  });
}

/** True when any step depends on a value the replay is not allowed to forward. */
export function flowCarriesSecret(flow: ReplayFlow): ReplayStep | undefined {
  return flow.steps.find((step) => step.value?.kind === "secret");
}

function navigationStep(index: number, to: string): ReplayStep | undefined {
  let parsed: URL;
  try {
    parsed = new URL(to);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return undefined;

  // A replay needs the query to reach the same screen, so keep the benign
  // parameters and drop only the credential-bearing ones. `redactUrl` is the
  // wrong tool here: it rewrites every value to "[REDACTED]", which is a worse
  // string to navigate with than no parameter at all.
  let queryWithheld = false;
  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (classifySecret(value, { name: key })) {
      queryWithheld = true;
      continue;
    }
    kept.append(key, value);
  }
  const query = kept.toString();

  return pruneUndefined({
    index,
    sig: `nav:${parsed.pathname}`,
    action: "navigate" as const,
    path: query ? `${parsed.pathname}?${query}` : parsed.pathname,
    queryWithheld: queryWithheld || undefined,
  });
}

function classifyValue(
  data: Record<string, unknown>,
  el: Record<string, unknown>,
): ReplayValueSource {
  const raw = data.val;
  if (typeof raw !== "string" || raw.length === 0) return { kind: "redacted" };
  if (raw === REDACTED_VALUE) return { kind: "redacted" };
  // A summary means the collector already rewrote the value.
  if (isRecord(data.valSummary)) return { kind: "redacted" };

  const name = asString(el.name);
  const type = asString(el.type);
  const secret = classifySecret(raw, { name, type });
  return secret
    ? { kind: "secret", reason: secret }
    : { kind: "literal", value: raw };
}

/**
 * The single credential test used for both input values and query parameters.
 * Returns the reason when the value must never be forwarded, `undefined` when
 * it is safe to replay.
 *
 * It defers to the platform's redaction policy rather than reimplementing one:
 * `redactInputValue` classifies the *field* (password/email/tel/search types and
 * sensitively-named fields report `sensitive_input_value`), and
 * `redactTokenLikeString` classifies the *value*.
 */
function classifySecret(
  raw: string,
  field: { name?: string; type?: string },
): string | undefined {
  const verdict = redactInputValue(raw, { ...field, path: "replay.value" });
  if (verdict.metadata?.fields[0]?.reason === "sensitive_input_value") {
    return `field ${describeField(field.name, field.type)} is credential-like`;
  }

  // Defence in depth: a value that looks like a token is a secret regardless of
  // which field it came from.
  if (redactTokenLikeString(raw, "replay.value").value !== raw) {
    return "value looks like a credential or token";
  }

  return undefined;
}

function describeField(name?: string, type?: string): string {
  if (name && type) return `"${name}" (type ${type})`;
  if (name) return `"${name}"`;
  if (type) return `of type ${type}`;
  return "value";
}

function roleFor(el: Record<string, unknown>): string | undefined {
  const explicit = asString(el.role);
  if (explicit) return explicit.toLowerCase();

  const tag = asString(el.tag)?.toLowerCase();
  if (!tag) return undefined;
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = asString(el.type)?.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  return undefined;
}

function labelFor(el: Record<string, unknown>): string | undefined {
  const text = asString(el.txt)?.trim();
  if (text) return text.slice(0, 120);
  const name = asString(el.name)?.trim();
  return name ? name.slice(0, 120) : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function pruneUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
