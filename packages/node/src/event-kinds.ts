// What the pipeline calls an event kind, and what it can actually do with one.
//
// Kinds are an open set — an SDK may emit one this build has never heard of —
// but "open" was quietly being read as "anything is fine". `/api/events`
// accepted any non-empty `k` and answered `{ ok: true, accepted: 4 }`, while
// post-process indexed exactly nothing from a batch of long-form kinds, and
// the session came out empty with no complaint anywhere in the chain. The two
// halves of the product also disagreed about the vocabulary: the dashboard
// labels `error`, `console`, `navigation` and `network`, and nothing on the
// capture side has ever produced or understood those spellings.
//
// So: long forms are aliased to the canonical kind on the way in, and a batch
// that lands nothing indexable says so in the response instead of reporting a
// clean success.

/**
 * Long-form kinds accepted as spellings of a canonical kind.
 *
 * These are the four the dashboard's `lib/kind-label.ts` already maps, which
 * is where the disagreement was visible. They arrive from hand-written init
 * snippets, the OTLP path and the mobile SDKs, all of which enter through the
 * same door as the browser SDK.
 */
export const EVENT_KIND_ALIASES: Readonly<Record<string, string>> = {
  error: "err",
  console: "con",
  network: "net.req",
  rejection: "rej",
  "failed-request": "net.err",
};

// `navigation` is deliberately NOT in that table. It is a canonical kind of the
// mobile wire contract (`CRUMBTRAIL_EVENT_KINDS.navigation`), the fixtures every
// native SDK is held to store it verbatim, and post-process already reads both
// spellings. Rewriting it would break the contract to fix a disagreement that
// does not exist.

/**
 * The canonical spelling of a kind: an alias resolves to its target, anything
 * else is returned trimmed and otherwise untouched. Alias matching ignores
 * case, because the same emitters that send `navigation` send `Navigation`.
 */
export function canonicalEventKind(kind: string): string {
  const trimmed = kind.trim();
  return EVENT_KIND_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Kinds post-process turns into something a reader or an agent can use — an
 * index entry, a correlation, a bundle section. Anything outside this set is
 * stored and counted and contributes to nothing else, which is exactly the
 * fact `/api/events` needs to report.
 *
 * Kept in step with `post-process.ts` (index building), `llm-bundle.ts`
 * (IMPORTANT_EVENT_KINDS) and `backend-events.ts`.
 */
export const INDEXED_EVENT_KINDS: ReadonlySet<string> = new Set([
  // Failures and their context
  "err",
  "rej",
  "con",
  "net.req",
  "net.res",
  "net.err",
  // Navigation and session shape
  "nav",
  "navigation",
  "session.lifecycle",
  "tab.boundary",
  // Interaction and page state
  "clk",
  "inp",
  "snap",
  "frame.ctx",
  "probe.ready",
  "probe.error",
  "bug.flag",
  "mark",
  // Backend and OpenTelemetry
  "backend.req.start",
  "backend.req.end",
  "backend.req.error",
  "backend.uncaught",
  "backend.otel.span",
  "backend.log",
  // The runtime's own statement about the process, and the outbound calls it
  // made. Both are read by evidence-index (`runtime_warning`, the payment and
  // checkout boundary detectors) and both were reported back to the sender as
  // unrecognized because they were never listed here.
  "backend.warning",
  "backend.http",
  // Background work. Nodes in the causal graph and a section in the bundle.
  "backend.job.start",
  "backend.job.end",
  "backend.job.error",
  // Database plane. Every db detector reads these, and a session whose only
  // evidence was a captured write was told nothing in it was indexable.
  "db.diff",
  "db.diff.bulk",
  "db.read",
  "db.read.bulk",
  "db.error",
  "db.statement",
  // Browser gauges the layout, arithmetic and listener-leak detectors read.
  "ui.num",
  "ui.layout",
  "ui.listeners",
  // Mobile and native (the wire contract's own kinds)
  "app-lifecycle",
  "native-crash",
  "view-snapshot",
  // Media, performance and transactions the timeline reads
  "perf",
  "media.voice",
  "media.video",
  "tx",
  "backend.otel.log",
  // Capture bookkeeping. The emitted kind is `capture_gap`
  // (CAPTURE_GAP_EVENT_KIND); `capture.gap` was a spelling nothing ever sent.
  "capture_gap",
]);

export interface EventKindReport {
  /** Events whose kind this build can index. */
  indexed: number;
  /** Distinct kinds it cannot, in first-seen order. Empty when there are none. */
  unrecognizedKinds: string[];
}

/** Classify a validated batch: how much of it will actually be usable. */
export function classifyEventKinds(
  events: readonly { k: string }[],
): EventKindReport {
  let indexed = 0;
  const unrecognized: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (INDEXED_EVENT_KINDS.has(event.k)) {
      indexed += 1;
      continue;
    }
    if (seen.has(event.k)) continue;
    seen.add(event.k);
    unrecognized.push(event.k);
  }
  return { indexed, unrecognizedKinds: unrecognized };
}
