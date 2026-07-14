// Advisory Jira comment builder. Turns a located/assembled bundle result into an
// Atlassian Document Format (ADF) document that Crumbtrail posts back on the
// ticket. Per VISION this is a CONSULTANT's note, never a verdict: it says what
// evidence was found and links to the full bundle, but it NEVER claims the bug is
// fixed/verified/reproduced and NEVER emits a boolean pass/fail. The branch is
// driven purely by the locate outcome ("matched" vs "inconclusive"); the raw
// confidence float is used ONLY to render a rounded display percentage and is
// never equality-compared.

/** The subset of the locate envelope this builder reads. `outcome` is the only
 *  signal that flips the comment shape; `confidence` is display-only. */
export interface AdvisoryCommentMatch {
  outcome: "matched" | "inconclusive";
  confidence: number;
  reasons?: string[];
}

/** One evidence gap surfaced from the bundle (mirrors core's EvidenceGap). */
export interface AdvisoryCommentGap {
  lane?: string;
  reason: string;
  suggestion?: string;
}

/**
 * Correlation keys carried INTO the ticket so the reader can line the matched
 * incident up against their own logs/traces. Every value here must come from the
 * located evidence — NEVER fabricated. Rendered only in the matched variant.
 */
export interface AdvisoryCommentCorrelation {
  /** The located session id (match.sessionId). */
  sessionId?: string;
  /** Distinct request/trace ids pulled from the bundle's evidence refs. */
  requestIds?: string[];
}

export interface BuildAdvisoryCommentInput {
  match: AdvisoryCommentMatch;
  /** Public link to the persisted bundle (`/api/bundles/:id`). Always rendered. */
  bundleUrl: string;
  gaps?: AdvisoryCommentGap[];
  /** Correlation keys from the located evidence (matched variant only). */
  correlation?: AdvisoryCommentCorrelation;
}

/**
 * Map an internal recall/locate reason CODE to a human-readable phrase. The
 * scorer emits terse tags ("semantic", "same-route", "time-proximity", …) that
 * are meaningful to us but opaque on a ticket; this turns them into plain
 * language. Codes are the exact strings emitted by scoreLocalIssue()
 * (packages/node/src/recall.ts) and locateIncident()
 * (packages/node/src/locate-incident.ts). Any unrecognized value passes through
 * unchanged so a free-text or future reason is never dropped or mangled.
 */
const REASON_PHRASES: Record<string, string> = {
  semantic: "wording overlap with the captured incident",
  "same-route": "same route",
  "same-error": "same error signature",
  "env-overlap": "shared environment or configuration",
  "time-proximity": "occurred near the report time",
  "release-hint": "same release",
};

function humanizeReason(reason: string): string {
  return REASON_PHRASES[reason] ?? reason;
}

/** A minimally-typed ADF node. ADF is an open tree; we only build the handful of
 *  node kinds we need (doc/paragraph/text/link/bulletList/listItem). */
export interface AdfNode {
  type: string;
  [key: string]: unknown;
}

export interface AdfDoc {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

function text(value: string): AdfNode {
  return { type: "text", text: value };
}

/** A text node rendered with the inline `code` mark — used for correlation-key
 *  values so they read as literal ids and are easy to copy off the ticket. */
function code(value: string): AdfNode {
  return { type: "text", text: value, marks: [{ type: "code" }] };
}

function link(label: string, href: string): AdfNode {
  return {
    type: "text",
    text: label,
    marks: [{ type: "link", attrs: { href } }],
  };
}

function paragraph(...content: AdfNode[]): AdfNode {
  return { type: "paragraph", content };
}

function bulletList(items: AdfNode[][]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((content) => ({
      type: "listItem",
      content: [paragraph(...content)],
    })),
  };
}

/**
 * Render the confidence float as a whole-number percentage for DISPLAY ONLY.
 * Never compare this (or the underlying float) with === to gate behavior — the
 * outcome field is the decision signal. Clamped to [0, 100] so a stray value
 * can't produce a nonsensical string.
 */
function confidencePercent(confidence: number): number {
  const pct = Math.round(confidence * 100);
  if (Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

function linkParagraph(label: string, bundleUrl: string): AdfNode {
  return paragraph(text(`${label} `), link(bundleUrl, bundleUrl));
}

/**
 * Build the correlation-key bullet lines (`Session: <id>`, `Request: <id>` …).
 * Filters empties, dedupes request ids, and caps them at 3 (defense-in-depth —
 * the webhook caller already dedupes/caps) so a runaway evidence set can't bloat
 * the comment. Returns [] when there is nothing real to show, so the caller
 * simply omits the block rather than fabricating keys.
 */
function correlationLines(
  correlation: AdvisoryCommentCorrelation | undefined,
): AdfNode[][] {
  if (!correlation) return [];
  const items: AdfNode[][] = [];
  const sessionId =
    typeof correlation.sessionId === "string"
      ? correlation.sessionId.trim()
      : "";
  if (sessionId) items.push([text("Session: "), code(sessionId)]);
  const seen = new Set<string>();
  for (const raw of correlation.requestIds ?? []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push([text("Request: "), code(id)]);
    if (seen.size >= 3) break;
  }
  return items;
}

/**
 * Build the advisory ADF comment. Two shapes, chosen by `match.outcome`:
 *
 * - matched: names that a candidate incident was located, shows the rounded
 *   confidence as an advisory percentage, lists the match reasons in plain
 *   language (if any), carries the correlation keys (located session + up to a
 *   few request/trace ids, when the evidence has them) onto the ticket, and
 *   links the full evidence bundle.
 * - inconclusive: states honestly that no recorded incident matched, lists the
 *   evidence gaps (if any) so the reader knows what is missing, and still links
 *   the (empty) bundle. It fabricates no match and reports no percentage.
 *
 * Pure and side-effect free — unit-testable in isolation.
 */
export function buildAdvisoryComment(input: BuildAdvisoryCommentInput): AdfDoc {
  const { match, bundleUrl } = input;
  const gaps = input.gaps ?? [];
  const content: AdfNode[] = [];

  if (match.outcome === "matched") {
    content.push(
      paragraph(
        text(
          "Crumbtrail located a candidate incident that likely matches this ticket.",
        ),
      ),
    );
    content.push(
      paragraph(
        text(
          `Match confidence: ${confidencePercent(match.confidence)}% (advisory — review the evidence before acting).`,
        ),
      ),
    );
    const reasons = (match.reasons ?? []).filter(
      (reason) => typeof reason === "string" && reason.trim().length > 0,
    );
    if (reasons.length > 0) {
      content.push(paragraph(text("Why this was matched:")));
      content.push(
        bulletList(reasons.map((reason) => [text(humanizeReason(reason))])),
      );
    }
    // Correlation keys: carry the located session + request/trace ids onto the
    // ticket so the reader can line the incident up against their logs/traces.
    // Only rendered from keys the evidence actually carries — never fabricated.
    const correlationItems = correlationLines(input.correlation);
    if (correlationItems.length > 0) {
      content.push(
        paragraph(
          text("Correlation keys (match these against your logs and traces):"),
        ),
      );
      content.push(bulletList(correlationItems));
    }
    content.push(linkParagraph("View the full evidence bundle:", bundleUrl));
    return { version: 1, type: "doc", content };
  }

  // inconclusive — honest, gaps-only, no fabricated match.
  content.push(
    paragraph(
      text(
        "Crumbtrail could not locate a recorded incident matching this ticket yet.",
      ),
    ),
  );
  const namedGaps = gaps.filter(
    (gap) =>
      gap && typeof gap.reason === "string" && gap.reason.trim().length > 0,
  );
  if (namedGaps.length > 0) {
    content.push(paragraph(text("What is missing:")));
    content.push(
      bulletList(
        namedGaps.map((gap) => {
          const label = gap.suggestion
            ? `${gap.reason} — ${gap.suggestion}`
            : gap.reason;
          return [text(label)];
        }),
      ),
    );
  }
  content.push(linkParagraph("Open the evidence bundle:", bundleUrl));
  return { version: 1, type: "doc", content };
}
