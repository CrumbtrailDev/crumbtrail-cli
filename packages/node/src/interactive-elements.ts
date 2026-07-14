import { redactTokenLikeString, redactUrl } from "crumbtrail-core";

export interface InteractiveElement {
  sig: string;
  path: string;
  tag?: string;
  txt?: string;
  count: number;
}

const INTERACTION_KINDS = new Set(["clk", "inp"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeText(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  if (!text) return undefined;
  return redactTokenLikeString(text, "interactiveElement").value.slice(0, 240);
}

function safeIdentifier(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  if (!text) return undefined;
  const sanitized = redactTokenLikeString(text, "interactiveElement.sig").value;
  return sanitized === text ? text.slice(0, 240) : "[REDACTED]";
}

function safePath(value: unknown): string {
  const text = asString(value)?.trim();
  if (!text) return "";
  const redacted = looksUrlLike(text)
    ? redactUrl(text, "interactiveElement.path").value
    : redactTokenLikeString(text, "interactiveElement.path").value;
  return redacted.slice(0, 240);
}

function looksUrlLike(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^\/[^ ]*\?/.test(value) ||
    /[?&][^=]+=[^&]+/.test(value)
  );
}

export function collectInteractiveElements(
  events: Array<{ k: string; d: Record<string, unknown> }>,
): InteractiveElement[] {
  const bySig = new Map<string, InteractiveElement>();

  for (const event of events) {
    if (!INTERACTION_KINDS.has(event.k)) continue;
    const el = event.d?.el;
    if (el == null || typeof el !== "object") continue;
    const record = el as Record<string, unknown>;
    const sig = asString(record.sig);
    if (!sig) continue;

    const existing = bySig.get(sig);
    if (existing) {
      existing.count++;
      continue;
    }
    bySig.set(sig, {
      sig: safeIdentifier(sig) ?? "[REDACTED]",
      path: safePath(record.path),
      tag: safeText(record.tag),
      txt: safeText(record.txt),
      count: 1,
    });
  }

  return Array.from(bySig.values()).sort((a, b) => b.count - a.count);
}
