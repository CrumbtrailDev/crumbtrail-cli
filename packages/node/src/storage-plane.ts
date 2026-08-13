import fs from "node:fs";
import path from "node:path";
import * as zlib from "node:zlib";
import type { BugEvent } from "crumbtrail-core";
import {
  BROWSER_REDACTION_POLICY_V2,
  REDACTED_VALUE,
  redactNetworkTextBody,
  redactTokenLikeString,
  redactUrl,
  setRedactionKeepFields,
} from "crumbtrail-core";
import type { EvidenceCandidate } from "./evidence-index";
import type { LlmBundle, LlmBundleRedactionSummary } from "./llm-bundle";
import { defaultSessionStore } from "./session-store";

export const SESSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const TWO_PLANE_LAYOUT_VERSION = 1 as const;
export const COLD_EVENTS_ARTIFACT = "events.ndjson.zst" as const;
export const SIGNATURES_ARTIFACT = "signatures.json" as const;
export const MANIFEST_ARTIFACT = "manifest.json" as const;
export const BUNDLE_ALIAS_ARTIFACT = "bundle.json" as const;
export const CAPTURE_TRUNCATED_ARTIFACT = "capture-truncated.json" as const;

export interface CaptureTruncationSummary {
  truncated: true;
  reason: "session_event_bytes_cap";
  maxEventBytes: number;
  eventsAccepted: number;
  eventsDropped: number;
  bytesWritten: number;
  truncatedAt: number;
}

interface SessionIndexForManifest {
  id?: string;
  start?: number;
  end?: number;
  dur?: number;
  evts?: number;
  stats?: Record<string, number>;
  errs?: Array<{ t: number; msg?: string }>;
  failedReqs?: Array<{
    t: number;
    m?: string;
    url?: string;
    st?: number;
    reason?: string;
    code?: string;
  }>;
  redaction?: LlmBundleRedactionSummary;
  truncated?: CaptureTruncationSummary;
}

interface SignatureDictionaryEntry {
  id: number;
  sig: string;
  path?: string;
  tag?: string;
  /**
   * The remaining `d.el` fields — text, label, href, name, id, class — that are
   * IDENTICAL on every event sharing this signature, so hoisting them here
   * describes the element rather than inventing a value for it. A field that
   * varies between two events, or is absent from one of them, never reaches
   * this map; it rides the cold event instead. Additive: a dictionary written
   * before this field existed simply has none.
   */
  desc?: Record<string, string>;
  firstSeen: number;
  firstEventKind: string;
}

interface SignatureDictionary {
  schemaVersion: 1;
  entries: SignatureDictionaryEntry[];
}

interface SignatureDictionaryBuildResult {
  dictionary: SignatureDictionary;
  entriesBySig: Map<string, SignatureDictionaryEntry>;
}

export interface WriteTwoPlaneSessionArtifactsInput {
  sessionDir: string;
  events: BugEvent[];
  index: SessionIndexForManifest;
  candidates: EvidenceCandidate[];
  bundle: LlmBundle;
  coldEvidence: ColdEvidenceArtifacts;
}

export interface WriteColdEvidenceArtifactsInput {
  sessionDir: string;
  events: BugEvent[];
}

export interface ColdEvidenceArtifacts {
  signatures: SignatureDictionary;
  sourceRawBytes: number;
  coldRawBytes: number;
  compressedBytes: number;
}

export async function writeColdEvidenceArtifacts(
  input: WriteColdEvidenceArtifactsInput,
): Promise<ColdEvidenceArtifacts> {
  const { dictionary: signatures, entriesBySig } = buildSignatureDictionary(
    input.events,
  );
  await writeGeneratedArtifact(
    input.sessionDir,
    SIGNATURES_ARTIFACT,
    `${JSON.stringify(signatures, null, 2)}\n`,
  );

  const coldEvents = input.events.map((event) =>
    prepareColdEvent(event, entriesBySig),
  );
  const coldNdjson =
    coldEvents.length > 0
      ? `${coldEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
  const compressed = compressColdEvents(Buffer.from(coldNdjson, "utf-8"));
  await writeGeneratedArtifact(
    input.sessionDir,
    COLD_EVENTS_ARTIFACT,
    compressed,
  );

  return {
    signatures,
    coldRawBytes: Buffer.byteLength(coldNdjson, "utf-8"),
    sourceRawBytes:
      existingFileBytes(path.join(input.sessionDir, "events.ndjson")) ??
      Buffer.byteLength(coldNdjson, "utf-8"),
    compressedBytes: compressed.byteLength,
  };
}

/**
 * Rehydrates the cold event stream back into analyzable {@link BugEvent}s.
 *
 * This is the read inverse of {@link writeColdEvidenceArtifacts}: it
 * decompresses `events.ndjson.zst` and expands each `d.el = { sigRef, ... }`
 * back into the descriptor shape the analyzer expects, using `signatures.json`
 * as the dictionary. Without that expansion every element anchored detector
 * sees a bare numeric ref and silently stops matching.
 *
 * The expansion is the whole descriptor, not just its identity half. Readers
 * take an element's text, label and href off `d.el` to say WHICH element a
 * finding is about; a round trip that returned only `{ sig, path, tag }` would
 * make two different elements indistinguishable, which both hides findings and
 * merges unrelated ones. Fields the dictionary hoisted (identical on every
 * event for that signature) come from the entry; fields that varied come off
 * the event itself and win, so no event is ever described by another's value.
 *
 * Returns undefined when the session has no cold artifact (a live session that
 * has not finalized yet, where `events.ndjson` is still the source of truth).
 * Cold events are already sanitized, so callers must not re-sanitize them.
 */
export function readColdEvents(sessionDir: string): BugEvent[] | undefined {
  const coldPath = path.join(sessionDir, COLD_EVENTS_ARTIFACT);
  if (!fs.existsSync(coldPath)) return undefined;
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error(
      "Crumbtrail cold storage requires Node.js >=22.15.0 for zstd decompression.",
    );
  }
  const raw = zlib.zstdDecompressSync(fs.readFileSync(coldPath)).toString(
    "utf-8",
  );
  const bySigRef = readSignatureDictionaryById(sessionDir);
  const events: BugEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Match readEvents: skip malformed lines rather than fail the replay.
    }
    if (!isRecord(parsed)) continue;
    events.push(rehydrateColdEvent(parsed as unknown as BugEvent, bySigRef));
  }
  return events;
}

/**
 * Reports the cold plane exactly as it already exists on disk, so a re-analysis
 * can rebuild the manifest without rewriting `events.ndjson.zst`.
 *
 * Byte counts come from the previous manifest when it is readable, because
 * `sourceRawBytes` records the size of the original `events.ndjson`, which is
 * gone by the time a session is cold and cannot be recovered from the
 * compressed copy. Falling back to the on-disk sizes keeps the ratio honest
 * (it reports cold-to-compressed) rather than inventing a figure.
 */
export function readColdEvidenceArtifacts(
  sessionDir: string,
): ColdEvidenceArtifacts | undefined {
  const compressedBytes = existingFileBytes(
    path.join(sessionDir, COLD_EVENTS_ARTIFACT),
  );
  if (compressedBytes === undefined) return undefined;
  const signatures = readSignatureDictionary(sessionDir);
  const manifest = readJsonRecord(path.join(sessionDir, MANIFEST_ARTIFACT));
  const cold = isRecord(manifest?.cold) ? manifest.cold : undefined;
  const compression = isRecord(cold?.compression) ? cold.compression : undefined;
  const coldRawBytes = finiteNumber(compression?.coldRawBytes);
  const sourceRawBytes = finiteNumber(compression?.sourceRawBytes);
  return {
    signatures,
    coldRawBytes: coldRawBytes ?? compressedBytes,
    sourceRawBytes: sourceRawBytes ?? coldRawBytes ?? compressedBytes,
    compressedBytes,
  };
}

function readSignatureDictionary(sessionDir: string): SignatureDictionary {
  const parsed = readJsonRecord(path.join(sessionDir, SIGNATURES_ARTIFACT));
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return {
    schemaVersion: 1,
    entries: entries.filter(
      (entry): entry is SignatureDictionaryEntry =>
        isRecord(entry) && finiteNumber(entry.id) !== undefined,
    ),
  };
}

function readSignatureDictionaryById(
  sessionDir: string,
): Map<number, SignatureDictionaryEntry> {
  const byId = new Map<number, SignatureDictionaryEntry>();
  for (const entry of readSignatureDictionary(sessionDir).entries)
    byId.set(entry.id, entry);
  return byId;
}

/** Expands `d.el = { sigRef }` back to the dictionary entry it points at. */
function rehydrateColdEvent(
  event: BugEvent,
  bySigRef: Map<number, SignatureDictionaryEntry>,
): BugEvent {
  const data = isRecord(event.d) ? event.d : undefined;
  if (!data) return event;
  const el = isRecord(data.el) ? data.el : undefined;
  const sigRef = finiteNumber(el?.sigRef);
  if (sigRef === undefined) return event;
  const entry = bySigRef.get(sigRef);
  // Per-event fields last: they are the value THIS event carried, so they
  // override anything the dictionary hoisted for the signature.
  const rehydrated: Record<string, unknown> = {
    ...(entry
      ? removeUndefined({
          sig: entry.sig,
          path: entry.path,
          tag: entry.tag,
          ...dictionaryDescriptorFields(entry),
        })
      : {}),
  };
  for (const [key, value] of Object.entries(el ?? {})) {
    if (key === COLD_ELEMENT_REF_KEY) continue;
    rehydrated[key] = value;
  }
  const nextData = { ...data };
  // A dangling ref with nothing else on it means signatures.json is missing or
  // truncated. Drop the placeholder rather than leave `{ sigRef }` behind, so
  // detectors treat the element as absent instead of matching against a
  // meaningless shape. Per-event fields that did survive are still real
  // evidence, so they are kept even when the entry cannot be resolved.
  if (Object.keys(rehydrated).length > 0) nextData.el = rehydrated;
  else delete nextData.el;
  return { ...event, d: nextData } as BugEvent;
}

/**
 * The hoisted descriptor half of an entry, defensively narrowed.
 *
 * `signatures.json` is read back off disk and may have been written by an older
 * build (no `desc` at all) or edited by hand, so only string values under
 * structurally safe names are admitted.
 */
function dictionaryDescriptorFields(
  entry: SignatureDictionaryEntry,
): Record<string, string> {
  const desc = (entry as { desc?: unknown }).desc;
  if (!isRecord(desc)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(desc)) {
    if (key === COLD_ELEMENT_REF_KEY || RESERVED_ELEMENT_KEYS.has(key)) continue;
    const safe = safeString(value);
    if (safe !== undefined && sanitizeKey(key, "d.el") === key) out[key] = safe;
  }
  return out;
}

export async function writeTwoPlaneSessionArtifacts(
  input: WriteTwoPlaneSessionArtifactsInput,
): Promise<void> {
  await writeGeneratedArtifact(
    input.sessionDir,
    BUNDLE_ALIAS_ARTIFACT,
    `${JSON.stringify(input.bundle, null, 2)}\n`,
  );

  const manifest = await buildManifest(input, input.coldEvidence);
  await writeGeneratedArtifact(
    input.sessionDir,
    MANIFEST_ARTIFACT,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeGeneratedArtifact(
  sessionDir: string,
  name: string,
  data: string | Buffer,
): Promise<void> {
  await defaultSessionStore.writeArtifact(sessionDir, name, data);
}

export function readCaptureTruncationMarker(
  sessionDir: string,
): CaptureTruncationSummary | undefined {
  const markerPath = path.join(sessionDir, CAPTURE_TRUNCATED_ARTIFACT);
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    if (
      !isRecord(parsed) ||
      parsed.truncated !== true ||
      parsed.reason !== "session_event_bytes_cap"
    )
      return undefined;
    const marker = removeUndefined({
      truncated: true as const,
      reason: "session_event_bytes_cap" as const,
      maxEventBytes: finiteNumber(parsed.maxEventBytes),
      eventsAccepted: finiteNumber(parsed.eventsAccepted),
      eventsDropped: finiteNumber(parsed.eventsDropped),
      bytesWritten: finiteNumber(parsed.bytesWritten),
      truncatedAt: finiteNumber(parsed.truncatedAt),
    });
    return typeof marker.maxEventBytes === "number" &&
      typeof marker.eventsAccepted === "number" &&
      typeof marker.eventsDropped === "number" &&
      typeof marker.bytesWritten === "number" &&
      typeof marker.truncatedAt === "number"
      ? (marker as CaptureTruncationSummary)
      : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeEventForStorage(event: BugEvent): BugEvent {
  return sanitizeRecord(
    event as unknown as Record<string, unknown>,
    "event",
  ) as unknown as BugEvent;
}

/** The key the cold event carries instead of repeating the signature string. */
const COLD_ELEMENT_REF_KEY = "sigRef";
/**
 * Descriptor names the entry already models at its top level, so `desc` never
 * shadows them. `d.el.id` (the element's DOM id) is deliberately NOT here: the
 * entry's numeric `id` lives beside `desc`, not inside it, so there is no
 * collision and the DOM id is hoisted like any other descriptive field.
 */
const RESERVED_ELEMENT_KEYS = new Set(["sig", "path", "tag"]);

/**
 * Builds the signature dictionary, hoisting into it only what it can describe
 * without inventing anything.
 *
 * Two passes, deliberately. The identity of an element (`sig`) is stable by
 * construction, but everything descriptive about it is not: the same button's
 * text changes as the UI updates, so a first-seen value replayed onto every
 * later event would fabricate evidence — the same class of defect as dropping
 * the field altogether, only harder to notice. A field is therefore hoisted
 * only when every event carrying that signature agreed on it; the moment two
 * events disagree, or one lacks the field, it is demoted and travels per event.
 *
 * Values are compared after {@link safeString} normalization, which is the same
 * normalization the entry stores, so a field longer than the entry's cap still
 * dedupes to the entry instead of being re-stored in full on every event.
 */
function buildSignatureDictionary(
  events: BugEvent[],
): SignatureDictionaryBuildResult {
  interface Accumulator {
    id: number;
    sig: string;
    firstSeen: number;
    firstEventKind: string;
    /** Fields agreed on by every occurrence so far. */
    shared: Map<string, string>;
  }
  const bySig = new Map<string, Accumulator>();

  for (const event of events) {
    const data = isRecord(event.d) ? event.d : {};
    const el = isRecord(data.el) ? data.el : undefined;
    const sig = safeId(el?.sig);
    if (!el || !sig) continue;
    const observed = normalizedDescriptorFields(sanitizeRecord(el, "d.el"));
    const existing = bySig.get(sig);
    if (!existing) {
      bySig.set(sig, {
        id: bySig.size + 1,
        sig: sanitizeIdentifier(sig, "d.el.sig"),
        firstSeen: finiteNumber(event.t) ?? 0,
        firstEventKind: safeString(event.k) ?? "unknown",
        shared: observed,
      });
      continue;
    }
    for (const [key, value] of existing.shared) {
      if (observed.get(key) !== value) existing.shared.delete(key);
    }
  }

  const entriesBySig = new Map<string, SignatureDictionaryEntry>();
  for (const [sig, acc] of bySig) {
    const desc: Record<string, string> = {};
    for (const [key, value] of acc.shared) {
      if (RESERVED_ELEMENT_KEYS.has(key)) continue;
      desc[key] = value;
    }
    entriesBySig.set(
      sig,
      removeUndefined({
        id: acc.id,
        sig: acc.sig,
        path: acc.shared.get("path"),
        tag: acc.shared.get("tag"),
        desc: Object.keys(desc).length > 0 ? desc : undefined,
        firstSeen: acc.firstSeen,
        firstEventKind: acc.firstEventKind,
      }),
    );
  }

  return {
    dictionary: { schemaVersion: 1, entries: [...entriesBySig.values()] },
    entriesBySig,
  };
}

/**
 * The already-sanitized `d.el` reduced to the string fields a dictionary entry
 * is able to hold, under the entry's own normalization. Non-strings and empty
 * strings are never hoisted; they stay on the event.
 */
function normalizedDescriptorFields(
  el: Record<string, unknown>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(el)) {
    if (key === COLD_ELEMENT_REF_KEY) continue;
    const safe = safeString(value);
    if (safe !== undefined) out.set(key, safe);
  }
  return out;
}

function prepareColdEvent(
  event: BugEvent,
  entriesBySig: Map<string, SignatureDictionaryEntry>,
): BugEvent {
  const sanitized = sanitizeEventForStorage(event);
  const data = isRecord(event.d) ? event.d : {};
  const el = isRecord(data.el) ? data.el : undefined;
  const sig = safeId(el?.sig);
  const entry = sig ? entriesBySig.get(sig) : undefined;
  if (!isRecord(sanitized.d)) sanitized.d = {};
  if (entry !== undefined) {
    const sanitizedEl = isRecord(sanitized.d.el) ? sanitized.d.el : {};
    sanitized.d = {
      ...sanitized.d,
      el: {
        [COLD_ELEMENT_REF_KEY]: entry.id,
        ...residualElementFields(sanitizedEl, entry),
      },
    };
  }
  return sanitized;
}

/**
 * What the cold event still has to carry: every `d.el` field the dictionary
 * entry does not already say the same thing about.
 *
 * This is field-agnostic on purpose. It restores the descriptor the readers
 * consume — text, label, href, name — without this module having to know which
 * of them any particular reader looks at, and it keeps the size win for the
 * fields (signature, structural path) that repeat unchanged across a session.
 */
function residualElementFields(
  el: Record<string, unknown>,
  entry: SignatureDictionaryEntry,
): Record<string, unknown> {
  const hoisted = dictionaryDescriptorFields(entry);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(el)) {
    if (key === COLD_ELEMENT_REF_KEY) continue;
    const shared =
      key === "sig"
        ? entry.sig
        : key === "path"
          ? entry.path
          : key === "tag"
            ? entry.tag
            : hoisted[key];
    if (shared !== undefined && safeString(value) === shared) continue;
    out[key] = value;
  }
  return out;
}

async function buildManifest(
  input: WriteTwoPlaneSessionArtifactsInput,
  storage: {
    signatures: SignatureDictionary;
    sourceRawBytes: number;
    coldRawBytes: number;
    compressedBytes: number;
  },
): Promise<Record<string, unknown>> {
  const meta = readJsonRecord(path.join(input.sessionDir, "meta.json")) ?? {};
  const start =
    finiteNumber(input.index.start) ??
    finiteNumber(meta.start) ??
    input.events[0]?.t ??
    0;
  const end =
    finiteNumber(input.index.end) ??
    finiteNumber(meta.end) ??
    input.events.at(-1)?.t ??
    start;
  const partitionStart = finiteNumber(meta.start) ?? start;
  const tenant = partitionSegment(meta.tenant, "local");
  const app = partitionSegment(meta.app, "unknown-app");
  const sessionId =
    safeSessionId(meta.id) ??
    safeSessionId(input.index.id) ??
    path.basename(input.sessionDir);
  const date = isoDate(partitionStart);
  const partitionPath = path.join(tenant, app, date, sessionId);
  const compressionRatio =
    storage.compressedBytes > 0
      ? Number((storage.sourceRawBytes / storage.compressedBytes).toFixed(2))
      : storage.sourceRawBytes === 0
        ? 1
        : storage.sourceRawBytes;

  // Hoisted out of the manifest literal because describeArtifacts now stats
  // through the async store seam. Order is preserved (hot, then cold).
  const hotArtifacts = await describeArtifacts(input.sessionDir, [
    MANIFEST_ARTIFACT,
    BUNDLE_ALIAS_ARTIFACT,
    "llm.json",
    "llm.md",
    "index.json",
    "candidates.jsonl",
    "CANDIDATES.md",
    "timeline.md",
    "search.jsonl",
  ]);
  const coldArtifacts = await describeArtifacts(input.sessionDir, [
    COLD_EVENTS_ARTIFACT,
    SIGNATURES_ARTIFACT,
    "recording.webm",
    "audio.webm",
    "frames",
  ]);

  return {
    schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
    kind: "crumbtrail.session-manifest",
    generatedAt: input.bundle.generatedAt,
    generatedAtIso: input.bundle.generatedAtIso,
    session: removeUndefined({
      id:
        safeString(meta.id) ??
        safeString(input.index.id) ??
        path.basename(input.sessionDir),
      tenant,
      app,
      startMs: start,
      endMs: end,
      durationMs: finiteNumber(input.index.dur) ?? Math.max(0, end - start),
      eventCount: finiteNumber(input.index.evts) ?? input.events.length,
      truncated: input.index.truncated?.truncated,
    }),
    partition: {
      convention: "{tenant}/{app}/{YYYY-MM-DD}/{sessionId}",
      tenant,
      app,
      date,
      sessionId,
      path: partitionPath,
      appliedToPath: sessionDirMatchesPartition(
        input.sessionDir,
        partitionPath,
      ),
    },
    hot: {
      layoutVersion: TWO_PLANE_LAYOUT_VERSION,
      artifacts: hotArtifacts.map((artifact) =>
        artifact.path === MANIFEST_ARTIFACT
          ? { ...artifact, exists: true }
          : artifact,
      ),
    },
    cold: {
      layoutVersion: TWO_PLANE_LAYOUT_VERSION,
      transcode: {
        format: "ndjson+zstd",
        status: "parquet-deferred",
        parquetDecision:
          "Deferred until a dependency-light Parquet writer is chosen; the plane split ships now with zstd-compressed NDJSON fallback.",
        redaction: "sanitized-before-cold-write",
      },
      artifacts: coldArtifacts,
      compression: {
        sourceRawBytes: storage.sourceRawBytes,
        coldRawBytes: storage.coldRawBytes,
        compressedBytes: storage.compressedBytes,
        ratio: compressionRatio,
      },
      signatures: {
        path: SIGNATURES_ARTIFACT,
        count: storage.signatures.entries.length,
      },
    },
    timeline: {
      eventCounts: Object.fromEntries(
        Object.entries(input.index.stats ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      errorMarkers: (input.index.errs ?? []).slice(0, 20).map((entry) =>
        removeUndefined({
          t: entry.t,
          msg: safeString(entry.msg),
        }),
      ),
      failedRequests: (input.index.failedReqs ?? []).slice(0, 20).map((entry) =>
        removeUndefined({
          t: entry.t,
          method: safeString(entry.m),
          url: safeUrlString(entry.url),
          status: entry.st,
          reason: safeString(entry.reason),
          code: safeString(entry.code),
        }),
      ),
    },
    candidates: input.candidates.slice(0, 20).map((candidate) => ({
      id: candidate.id,
      detector: candidate.detector,
      severity: candidate.severity,
      basis: "heuristic" as const,
      baseScore: candidate.score,
      score: candidate.score,
      anchor: candidate.anchor,
      evidenceWindow: candidate.evidenceWindow,
    })),
    redaction: input.index.redaction,
    ...(input.index.truncated ? { truncation: input.index.truncated } : {}),
    accessPattern: [
      "Read manifest.json first.",
      "Use candidates.jsonl and windows/*.md for bounded drill-down.",
      "Open events.ndjson.zst only when raw chronological evidence is required.",
    ],
  };
}

async function describeArtifacts(
  sessionDir: string,
  names: string[],
): Promise<Array<Record<string, unknown>>> {
  const described: Array<Record<string, unknown>> = [];
  // Serial (not Promise.all) so the emitted order matches `names` exactly and
  // the store sees the same one-at-a-time access pattern it did when sync.
  for (const name of names) {
    const stat = await defaultSessionStore.statArtifact(sessionDir, name);
    if (!stat) {
      described.push({ path: name, exists: false });
      continue;
    }
    const entries = stat.isDir
      ? (await defaultSessionStore.listArtifacts(path.join(sessionDir, name)))
          .length
      : undefined;
    described.push(
      removeUndefined({
        path: name,
        exists: true,
        bytes: !stat.isDir ? stat.bytes : undefined,
        entries,
      }),
    );
  }
  return described;
}

function compressColdEvents(input: Buffer): Buffer {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      "Crumbtrail cold storage requires Node.js >=22.15.0 for zstd compression.",
    );
  }
  return zlib.zstdCompressSync(input);
}

/**
 * Field names the operator has declared product content rather than personal data.
 *
 * The rules below are name-based and table-blind: `SENSITIVE_NAME_RE` contains the
 * literal token `body`, so `payments.body` (a raw gateway payload) and
 * `reviews.body` (the shopper text that IS the defect on a stored-XSS ticket) are
 * treated identically, and both rest as `[REDACTED]`. Same for `email` on a
 * duplicate-account bug and `postal` on an address-validation bug. The evidence
 * that explains those defects is destroyed by the policy meant to protect it, and
 * until now there was no way to say otherwise.
 *
 * This is the keep half of the client-controlled capture policy. Deliberately
 * opt-in, process-wide, and narrow: it exempts a name from the *name-based* rules
 * only. Value-based detection still runs, so a token or a card number pasted into
 * a kept field is still caught, and a non-primitive is still swept whole.
 */
let keepFieldNames: Set<string> = new Set();

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Replaces the keep list. Pass an empty list to restore deny-biased defaults. */
export function setStorageKeepFields(names: readonly string[] = []): void {
  keepFieldNames = new Set(
    names
      .filter((name) => typeof name === "string" && name.trim())
      .map(normalizeFieldName),
  );
  // The URL paths in crumbtrail-core read their policy from module scope, so
  // one call configures both halves. Without this a name would be kept in a
  // db.diff row and still `[REDACTED]` in the query string that produced it.
  setRedactionKeepFields([...keepFieldNames]);
}

/** The active keep list, for reporting it back in a capture-policy summary. */
export function getStorageKeepFields(): string[] {
  return [...keepFieldNames].sort();
}

function isKeptFieldName(key: string): boolean {
  return keepFieldNames.size > 0 && keepFieldNames.has(normalizeFieldName(key));
}

function sanitizeValue(value: unknown, fieldPath: string): unknown {
  if (typeof value === "string") {
    if (isSafeSdkDescriptorValue(fieldPath, value)) return value;
    if (
      isSafeCorrelationPath(fieldPath) &&
      isSafeCorrelationValue(fieldPath, value)
    )
      return value;
    if (isSensitiveField(fieldPath)) return REDACTED_VALUE;
    return sanitizeString(value, fieldPath);
  }
  if (Array.isArray(value))
    return value.map((entry, index) =>
      sanitizeValue(entry, `${fieldPath}[${index}]`),
    );
  if (isRecord(value)) return sanitizeRecord(value, fieldPath);
  return value;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  fieldPath: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = sanitizeKey(key, fieldPath);
    const childPath = `${fieldPath}.${safeKey}`;
    if (
      typeof raw === "string" &&
      isSafeCorrelationPath(childPath) &&
      isSafeCorrelationValue(childPath, raw)
    ) {
      out[safeKey] = raw;
      continue;
    }
    // `reqBody` and `responseBody` alongside `body`: each plane records the
    // payload it saw under its own key, and those names carry the literal token
    // `body`, so the name-based rule would sweep the one sentence that explains
    // a 500 to `[REDACTED]` while the payload beside it stayed readable. Same
    // gate as the browser's body — kept only when the event declares it already
    // went through the v2 policy.
    if (
      (key === "body" || key === "reqBody" || key === "responseBody") &&
      fieldPath === "event.d" &&
      typeof raw === "string" &&
      declaresStructuredBodyRedaction(value)
    ) {
      out[safeKey] = sanitizeStructuredBody(raw, declaredKeepFields(value));
      continue;
    }
    if (key === "bodyMeta" && fieldPath === "event.d") {
      out[safeKey] = sanitizeBodyMeta(raw, value);
      continue;
    }
    // An operator-declared keep exempts this name from the name-based rules, but
    // only for a primitive: a nested object could carry anything, so it still
    // goes through sanitizeValue below and is swept in full.
    if (isKeptFieldName(key) && (typeof raw !== "object" || raw === null)) {
      out[safeKey] =
        typeof raw === "string" ? sanitizeString(raw, childPath) : raw;
      continue;
    }
    if (
      (isSensitiveName(key) && !isSafeMetadataField(key)) ||
      isSensitiveField(childPath) ||
      safeKey === REDACTED_VALUE
    ) {
      out[safeKey] = REDACTED_VALUE;
      continue;
    }
    out[safeKey] = sanitizeValue(raw, childPath);
  }
  return out;
}

/**
 * A network event body is kept at rest only when the emitting SDK declared
 * structured (v2) redaction for the event AND the server's own structured
 * classifier successfully re-processes it. The client declaration is a hint,
 * never a grant: every value in the body is re-classified here, so a client
 * that lies about its policy still cannot store secrets. Anything that fails
 * the re-run (non-JSON, oversized, parse error) collapses to the blanket
 * REDACTED_VALUE this sanitizer always used.
 */
function declaresStructuredBodyRedaction(
  record: Record<string, unknown>,
): boolean {
  const redaction = record.redaction;
  return (
    isRecord(redaction) && redaction.policy === BROWSER_REDACTION_POLICY_V2
  );
}

/**
 * `net.res` `d.bodyMeta` is the response-body summary the browser SDK derives
 * from the ALREADY REDACTED body text: `{ct, bytes?, truncated?, data?,
 * arrayTotal?}`. Its key contains the literal token `body`, so the name-based
 * rule would sweep the whole envelope to `[REDACTED]` and destroy the size and
 * shape facts detectors join against.
 *
 * The envelope (media type, byte count, truncation flags, true array lengths)
 * carries no captured values, so it is validated structurally and kept
 * regardless of declaration. `data` DOES carry values — the parsed view of the
 * redacted body — so it is held to the same standard as `d.body`: kept only
 * when the emitting SDK declared structured (v2) redaction, and then re-swept
 * by the generic sanitizer, so a client that lies about its policy still
 * cannot store secrets through the summary.
 */
function sanitizeBodyMeta(
  raw: unknown,
  eventData: Record<string, unknown>,
): unknown {
  if (!isRecord(raw)) return REDACTED_VALUE;
  const ct =
    typeof raw.ct === "string" && /^[a-z0-9!#$&^_+./-]{1,80}$/.test(raw.ct)
      ? raw.ct
      : undefined;
  if (ct === undefined) return REDACTED_VALUE;
  const out: Record<string, unknown> = { ct };
  const bytes = finiteNumber(raw.bytes);
  if (bytes !== undefined && bytes >= 0) out.bytes = bytes;
  if (raw.truncated === true) out.truncated = true;
  if (isRecord(raw.arrayTotal)) {
    const totals: Record<string, number> = {};
    for (const [totalPath, totalValue] of Object.entries(raw.arrayTotal)) {
      if (Object.keys(totals).length >= MAX_BODY_META_ARRAY_TOTALS) break;
      const total = finiteNumber(totalValue);
      if (total === undefined || total < 0) continue;
      if (!/^\$[A-Za-z0-9_.$[\]]{0,120}$/.test(totalPath)) continue;
      totals[totalPath] = total;
    }
    if (Object.keys(totals).length > 0) out.arrayTotal = totals;
  }
  if (raw.data !== undefined && declaresStructuredBodyRedaction(eventData)) {
    out.data = sanitizeValue(raw.data, "event.d.bodyMeta.data");
  }
  return out;
}

const MAX_BODY_META_ARRAY_TOTALS = 32;

/** Field names of a declared keep list, ignoring anything that is not one. */
const DECLARED_KEEP_NAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const MAX_DECLARED_KEEP_FIELDS = 64;

/**
 * The keep list the emitting SDK declared alongside its v2 policy.
 *
 * The re-run below is a re-classification, not a rubber stamp, so it has to be
 * told the same name exemptions that produced the body it is re-reading. Told
 * nothing, it placeholders every name the application deliberately kept, which
 * is why a declared `error` or `message` still reached disk as `[REDACTED]`.
 *
 * The declaration exempts a NAME from the name-based rules only. Every
 * value-based check still runs against the value under that name, so an
 * application cannot use its keep list to store a token, a card number or an
 * email. Entries are shape-checked and bounded here, because the field names
 * themselves are attacker-controlled text on the way to a classifier.
 */
function declaredKeepFields(eventData: Record<string, unknown>): string[] {
  const redaction = eventData.redaction;
  if (!isRecord(redaction) || !Array.isArray(redaction.keep)) return [];
  return redaction.keep
    .filter(
      (name): name is string =>
        typeof name === "string" && DECLARED_KEEP_NAME_RE.test(name),
    )
    .slice(0, MAX_DECLARED_KEEP_FIELDS);
}

function sanitizeStructuredBody(body: string, declaredKeep: string[]): string {
  // The operator's list and the application's declaration are both name
  // exemptions of the same kind, so the re-run honors their union.
  const keepFields = [...new Set([...getStorageKeepFields(), ...declaredKeep])];
  try {
    const result = redactNetworkTextBody(body, {
      contentType: "application/json",
      path: "event.d.body",
      mode: "structured",
      ...(keepFields.length > 0 ? { keepFields } : {}),
    });
    if (
      typeof result.body === "string" &&
      result.bodySummary?.reason === "structured_redaction"
    ) {
      return result.body;
    }
  } catch {
    /* fall through to blanket redaction */
  }
  return REDACTED_VALUE;
}

function sanitizeKey(key: string, fieldPath: string): string {
  if (isPrototypeSpecialKey(key)) return REDACTED_VALUE;
  if (isSafeStructuralKey(key, fieldPath)) return key;
  const sanitized = sanitizeString(key, `${fieldPath}.$key`);
  if (sanitized === key) return key;
  return REDACTED_VALUE;
}

function sanitizeString(value: string, fieldPath: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const urlRedacted =
    isUrlField(fieldPath) || looksUrlLike(trimmed)
      ? redactUrl(trimmed, fieldPath).value
      : trimmed;
  return redactTokenLikeString(urlRedacted, fieldPath).value;
}

function sanitizeIdentifier(value: string, fieldPath: string): string {
  const sanitized = sanitizeString(value, fieldPath);
  return sanitized === value ? value : REDACTED_VALUE;
}

function isSensitiveField(fieldPath: string): boolean {
  return fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .filter((segment) => !isSafeMetadataField(segment))
    .some((segment) => isSensitiveName(segment));
}

function isSafeCorrelationField(segment: string): boolean {
  return SAFE_CORRELATION_FIELD_NAMES.has(segment);
}

function isSafeSdkDescriptorValue(fieldPath: string, value: string): boolean {
  if (fieldPath !== "event.sdk.name" && fieldPath !== "event.sdk.version")
    return false;
  if (redactTokenLikeString(value, fieldPath).value !== value) return false;
  return /^[@A-Za-z0-9_.:/-]{1,128}$/.test(value);
}

function isSafeCorrelationPath(fieldPath: string): boolean {
  const leaf = fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .at(-1);
  return SAFE_CORRELATION_VALUE_FIELD_NAMES.has(leaf ?? "");
}

function isSafeCorrelationValue(fieldPath: string, value: string): boolean {
  const leaf = fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .at(-1);
  if (leaf === "traceId")
    return /^[a-f0-9]{32}$/i.test(value) && !/^0{32}$/.test(value);
  if (leaf === "spanId" || leaf === "parentSpanId")
    return /^[a-f0-9]{16}$/i.test(value) && !/^0{16}$/.test(value);
  if (
    leaf === "requestId" &&
    /^[a-f0-9]{32}$/i.test(value) &&
    !/^0{32}$/.test(value)
  )
    return true;
  if (leaf === "sessionId") {
    if (fieldPath !== "event.sessionId" && fieldPath !== "event.d.sessionId")
      return false;
    if (redactTokenLikeString(value, fieldPath).value !== value) return false;
    return /^sess?[A-Za-z0-9_.:-]{1,124}$/.test(value);
  }
  if (redactTokenLikeString(value, fieldPath).value !== value) return false;
  if (leaf === "requestIdSource" || leaf === "sessionIdSource")
    return /^[A-Za-z0-9_.:-]{1,40}$/.test(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isSafeMetadataField(segment: string): boolean {
  return SAFE_METADATA_FIELD_NAMES.has(segment);
}

function isSafeStructuralKey(key: string, fieldPath: string): boolean {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return false;
  if (isPrototypeSpecialKey(key)) return false;
  if (isSensitiveName(key) && !isSafeMetadataField(key)) return false;
  if (isSensitiveField(`${fieldPath}.${key}`)) return false;
  return sanitizeString(key, `${fieldPath}.$key`) === key;
}

function isPrototypeSpecialKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isUrlField(fieldPath: string): boolean {
  return /(^|\.)(url|href|to|from|rootUrl|pathname|name)(\.|$)/i.test(
    fieldPath,
  );
}

function looksUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^\/[^ ]*\?/.test(value);
}

function safeUrlString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(redactUrl(value, "url").value);
}

function existingFileBytes(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isoDate(value: number): string {
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

function sessionDirMatchesPartition(
  sessionDir: string,
  partitionPath: string,
): boolean {
  const actualSuffix = path
    .normalize(sessionDir)
    .split(path.sep)
    .filter(Boolean)
    .slice(-4)
    .join(path.sep);
  return actualSuffix === partitionPath;
}

function partitionSegment(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  const normalized = text
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function safeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : undefined;
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[a-z0-9_.:-]{1,160}$/i.test(text) ? text : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-session-id",
]);

const SENSITIVE_NAME_RE =
  /(^|[^a-z0-9])(access[-_]?token|api[-_]?key|auth|authorization|bearer|body|card|client[-_]?secret|cookie|credential|csrf|id[-_]?token|jwt|mfa|otp|pass(code|word)?|passwd|private[-_]?key|raw[-_]?payload|refresh[-_]?token|secret|session|sid|ssn|token|xsrf)([^a-z0-9]|$)/i;
const PII_NAME_RE =
  /(^|[^a-z0-9])(email|phone|address|dob|birthdate|postal|zip)([^a-z0-9]|$)/i;
const SENSITIVE_COMPACT_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apikeys",
  "auth",
  "authentication",
  "authenticationinfo",
  "authkey",
  "authtoken",
  "authorization",
  "authorizationinfo",
  "bearer",
  "body",
  "cardnumber",
  "clientsecret",
  "cookie",
  "credentials",
  "creds",
  "csrf",
  "csrfkey",
  "csrftoken",
  "cvc",
  "cvv",
  "idtoken",
  "jsessionid",
  "jwt",
  "mfa",
  "otp",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "passwordconfirmation",
  "passwords",
  "pin",
  "privatekey",
  "proxyauthentication",
  "proxyauthenticationinfo",
  "pwd",
  "rawpayload",
  "refreshtoken",
  "secret",
  "secrets",
  "securitycode",
  "session",
  "sessionid",
  "sid",
  "ssn",
  "token",
  "tokenkey",
  "tokens",
  "verificationcode",
  "xapikey",
  "xauthkey",
  "xauthtoken",
  "xcsrf",
  "xcsrfkey",
  "xcsrftoken",
  "xsrf",
  "xsrfkey",
  "xsrftoken",
  "xxsrf",
  "xxsrfkey",
  "xxsrftoken",
]);
const SAFE_CORRELATION_FIELD_NAMES = new Set([
  "id",
  "requestId",
  "requestIdSource",
  "sessionId",
  "sessionIdSource",
  "spanId",
  "traceId",
  "parentSpanId",
]);
const SAFE_CORRELATION_VALUE_FIELD_NAMES = new Set([
  "requestId",
  "requestIdSource",
  "sessionId",
  "sessionIdSource",
  "spanId",
  "traceId",
  "parentSpanId",
]);
const SAFE_METADATA_FIELD_NAMES = new Set([
  // Derived summary envelope of the redacted response body; admitted through
  // its own declaration-gated branch in sanitizeRecord, and listed here so the
  // path-segment sensitivity check does not sweep its descendants wholesale.
  "bodyMeta",
  "bodySummary",
  "reqBodySummary",
  "hrefSummary",
  "newValSummary",
  "oldValSummary",
  "payloadSummary",
  "textSummary",
  "valSummary",
  "valueSummary",
]);

function isSensitiveName(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_NAME_RE.test(name) ||
    PII_NAME_RE.test(name) ||
    SENSITIVE_NAME_RE.test(normalized) ||
    PII_NAME_RE.test(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact)
  );
}
