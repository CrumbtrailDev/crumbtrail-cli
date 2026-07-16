export type Severity = "critical" | "high" | "medium" | "low";

export interface SessionSummary {
  id: string;
  release?: string;
  build?: string;
  start: number;
  end?: number;
  dur?: number;
  evts?: number;
  errors: number;
  failedReqs: number;
  topSeverity?: Severity;
  title?: string;
  hasVideo: boolean;
  hasDiagnosis: boolean;
}

export interface SessionFileFlags {
  hasVideo: boolean;
  hasDiagnosis: boolean;
  topSeverity?: Severity;
}

const TITLE_MAX_LENGTH = 120;

// Maps already-parsed meta.json / index.json into a SessionSummary. Pure: it performs
// no filesystem I/O. The caller discovers file flags (recording.webm / opinion.json
// presence, candidate-derived severity) and passes them via fileFlags.
export function buildSessionSummary(
  metaJson: unknown,
  indexJson: unknown,
  fileFlags: SessionFileFlags,
): SessionSummary {
  const meta = isRecord(metaJson) ? metaJson : {};
  const index = isRecord(indexJson) ? indexJson : {};

  const errs = Array.isArray(index.errs) ? index.errs : [];
  const failedReqs = Array.isArray(index.failedReqs) ? index.failedReqs : [];
  const navs = Array.isArray(index.navs) ? index.navs : [];

  const errors = errs.length;
  const failedReqCount = failedReqs.length;

  const id = str(index.id) ?? str(meta.id) ?? "";
  const release = str(meta.release) ?? str(meta.releaseId) ?? str(meta.version);
  const build =
    str(meta.build) ?? str(meta.buildId) ?? str(meta.commit) ?? str(meta.sha);
  const start = num(index.start) ?? num(meta.start) ?? 0;
  const end = num(index.end) ?? num(meta.end);
  const dur = num(index.dur) ?? num(meta.dur);
  const evts = num(index.evts) ?? num(meta.evts);

  const summary: SessionSummary = {
    id,
    start,
    errors,
    failedReqs: failedReqCount,
    hasVideo: fileFlags.hasVideo === true,
    hasDiagnosis: fileFlags.hasDiagnosis === true,
  };
  if (release !== undefined) summary.release = release;
  if (build !== undefined) summary.build = build;
  if (end !== undefined) summary.end = end;
  if (dur !== undefined) summary.dur = dur;
  if (evts !== undefined) summary.evts = evts;

  // Severity precedence: a candidate-derived severity (passed in by the caller) wins.
  // Otherwise derive a coarse fallback from the failure counts.
  const topSeverity =
    fileFlags.topSeverity ?? deriveSeverity(errors, failedReqCount);
  if (topSeverity) summary.topSeverity = topSeverity;

  const title = deriveTitle(errs, navs, meta, id);
  if (title) summary.title = title;

  return summary;
}

function deriveSeverity(
  errors: number,
  failedReqs: number,
): Severity | undefined {
  if (errors > 0) return "high";
  if (failedReqs > 0) return "medium";
  return undefined;
}

function deriveTitle(
  errs: unknown[],
  navs: unknown[],
  meta: Record<string, unknown>,
  id: string,
): string | undefined {
  const firstErr =
    errs.length > 0 && isRecord(errs[0]) ? str(errs[0].msg) : undefined;
  if (firstErr) return truncate(firstErr);

  const firstNav =
    navs.length > 0 && isRecord(navs[0]) ? str(navs[0].to) : undefined;
  if (firstNav) return truncate(firstNav);

  const metaTitle = str(meta.rootUrl) ?? str(meta.url) ?? str(meta.title);
  if (metaTitle) return truncate(metaTitle);

  return id ? truncate(id) : undefined;
}

function truncate(value: string): string {
  return value.length > TITLE_MAX_LENGTH
    ? value.slice(0, TITLE_MAX_LENGTH)
    : value;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
