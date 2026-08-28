// Verification (plans/cli-setup-wizard-design.md §4):
//   Real-event poll — poll GET /api/sessions for a NON-synthetic session that
//   either did not exist when the wait opened or has captured something since,
//   using
//   poll.ts's ported backoff. Cancellable via AbortSignal (Ctrl-C). The installer
//   is hands-off (it mints no key), so the earlier synthetic-ingest check is gone:
//   there is no key to push a marker session with. An event only arrives once the
//   user sets their key and starts the app, which this poll waits for.

import { requestJson } from "./net";
import {
  DEFAULT_INGEST_POLL_CONFIG,
  initialIngestPollState,
  nextPollDelayMs,
  recordPollAttempt,
  type IngestPollConfig,
} from "./poll";
import { color, type Ui } from "./ui";
import { caps, glyphs, startSpinner } from "./theme";

/**
 * The reserved prefix the cloud recognizes and refuses to persist. Retained so
 * the poll still filters out any stray `cli-check-` sessions from earlier runs.
 */
export const CLI_CHECK_PREFIX = "cli-check-";

export interface SessionRow {
  id: string;
  serviceId?: string | null;
  /** ISO timestamp the cloud reports for when the session started. */
  startedAt?: string | null;
  /** Cloud flag: true once this session has captured at least one event. */
  hasEvents?: boolean;
  /** Events the session index counted, when the index was readable. */
  eventCount?: number;
}

/**
 * How much a session had captured at one point in time.
 *
 * The backend SDK keeps ONE long lived auto session per process, so an app that
 * is already running when the wait opens produces no new session id however
 * much traffic it takes. Its existing session's counters are the only thing
 * that moves, which is why the poll snapshots them and not just the ids.
 */
export interface SessionActivity {
  hasEvents: boolean;
  eventCount: number;
}

/** The comparable activity of one row. A missing/unreadable index reads as 0. */
export function sessionActivity(s: SessionRow): SessionActivity {
  return {
    hasEvents: s.hasEvents === true,
    eventCount:
      typeof s.eventCount === "number" && Number.isFinite(s.eventCount)
        ? s.eventCount
        : 0,
  };
}

/**
 * How far a session's cloud-reported `startedAt` may fall BEFORE the locally
 * captured `wizardStart` and still count as "new". The local machine clock and
 * the cloud clock are independent wall clocks, so a strict `startedAt >=
 * wizardStart` compares two unsynchronized timebases: if the cloud runs behind
 * the CLI (or it stamps `startedAt` a moment before the CLI opened its window),
 * a genuine event's timestamp lands just short of `wizardStart` and is wrongly
 * rejected. This bound absorbs that gap. It is deliberately generous (skew that
 * survives NTP is rare) yet bounded, so it can't resurrect a session from a much
 * earlier run. It applies ONLY on the timestamp fallback path — when an identity
 * baseline is available (see `RealSessionGuard.baselineIds`) no clock comparison
 * happens at all.
 */
export const POLL_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

export interface RealSessionGuard {
  /**
   * IDs of the sessions that already existed when the verify window opened. This
   * is the ROBUST anchor: a session is "new" iff its id is absent from this set,
   * a comparison made entirely in the cloud's own id namespace, so it is immune
   * to local/cloud clock skew AND to `startedAt`-vs-window divergence. An empty
   * set is a valid baseline ("nothing existed yet"); `undefined` means no
   * baseline was captured, so the timestamp fallback is used instead.
   */
  baselineIds?: ReadonlySet<string>;
  /**
   * What each already-existing session had captured when the window opened,
   * keyed by session id. A row whose event count rose above this, or whose
   * `hasEvents` flipped on, is an arrival even though its id is not new.
   */
  baselineActivity?: ReadonlyMap<string, SessionActivity>;
  /**
   * Lower-bound tolerance (ms) for the timestamp fallback. Defaults to 0 so
   * pure callers keep the exact `startedAt >= wizardStart` cliff; the poll loop
   * passes {@link POLL_SKEW_TOLERANCE_MS} for its degraded (no-baseline) path.
   */
  skewToleranceMs?: number;
}

/**
 * Is `s` the user's genuine new session — not the synthetic marker, and not one
 * that predated this verify window? Prefers the skew-proof identity baseline;
 * only when none was captured does it fall back to comparing the cloud's
 * `startedAt` against the local `wizardStart` (widened by `skewToleranceMs`).
 */
export function isRealNewSession(
  s: SessionRow,
  wizardStart?: number,
  guard?: RealSessionGuard,
): boolean {
  if (s.id.startsWith(CLI_CHECK_PREFIX)) return false;
  // Primary anchor: identity in the cloud's own id namespace — never crosses
  // clock domains, so clock skew and startedAt divergence can't fool it.
  if (guard?.baselineIds) return !guard.baselineIds.has(s.id);
  // Fallback: no baseline, so trust `startedAt` but only within a bounded skew
  // tolerance, so a slightly-behind cloud clock doesn't drop a real event.
  if (wizardStart == null) return true;
  const started = s.startedAt ? Date.parse(s.startedAt) : NaN;
  const tolerance = Math.max(0, guard?.skewToleranceMs ?? 0);
  return Number.isFinite(started) && started >= wizardStart - tolerance;
}

/**
 * Did an already-existing session capture something new since the baseline?
 *
 * This is the half of "an event arrived" that identity alone cannot see. False
 * without a baseline (nothing to compare against) and false for a session that
 * did not exist yet, which {@link isRealNewSession} already covers.
 */
export function hasNewEvents(s: SessionRow, guard?: RealSessionGuard): boolean {
  const before = guard?.baselineActivity?.get(s.id);
  if (!before) return false;
  const now = sessionActivity(s);
  if (now.eventCount > before.eventCount) return true;
  return now.hasEvents && !before.hasEvents;
}

/**
 * Did this row carry an event into the window — either as a session that did
 * not exist before, or as one that did and has captured more since?
 *
 * Waiting only for a new session id told a customer whose app was already
 * running that setup had failed, while their events were landing on the session
 * that process opened at boot.
 */
export function isArrival(
  s: SessionRow,
  wizardStart?: number,
  guard?: RealSessionGuard,
): boolean {
  if (s.id.startsWith(CLI_CHECK_PREFIX)) return false;
  return isRealNewSession(s, wizardStart, guard) || hasNewEvents(s, guard);
}

/**
 * The first genuinely-new NON-synthetic session, if any — powers the deep link.
 * "Arrived" is decided by {@link isArrival}: a session id absent from the
 * baseline, or a baseline session whose captured events rose. Without a
 * baseline it falls back to a bounded-tolerance `startedAt` vs `wizardStart`
 * check, and with neither the filter is skipped (legacy callers / unit fixtures
 * without timestamps).
 */
export function firstRealSession(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): SessionRow | undefined {
  return sessions.find((s) => isArrival(s, wizardStart, guard));
}

/** True once a genuinely-new non-synthetic session exists in the page. */
export function hasRealSession(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): boolean {
  return firstRealSession(sessions, wizardStart, guard) !== undefined;
}

export type RealEventOutcome = "found" | "timedout" | "cancelled";

/**
 * What the wait actually observed when it ended empty.
 *
 * A wait that learned nothing and a wait that watched a quiet project are
 * different facts, and the note the wizard prints has to be able to tell them
 * apart instead of asserting a cause it never checked.
 */
export type PollTimeoutReason =
  /** Every read of the sessions feed failed, so nothing was observed at all. */
  | "reads-failed"
  /** The project has no sessions, so nothing has ever reported in. */
  | "no-sessions"
  /** Sessions exist; none was created and none captured anything new. */
  | "no-new-activity";

export interface PollRealEventResult {
  outcome: RealEventOutcome;
  /** Set when outcome is "found" — the session behind the first real event. */
  sessionId?: string;
  /** Set only when outcome is "timedout" — what the wait actually saw. */
  reason?: PollTimeoutReason;
  /** Sessions the project already had when the wait opened, when it was read. */
  baselineSessionCount?: number;
}

/**
 * One application's ingest counters, as `/api/stats` reports them.
 *
 * The sessions feed cannot answer "are events arriving" for a session that is
 * still open: its index.json does not exist until the session is processed, so
 * every live row comes back with no event count at all. `/api/stats` keeps the
 * counters the ingest path stamps as events land, which is the only read that
 * moves while an already-running app keeps reporting into the session it opened
 * at boot.
 */
export interface IngestActivity {
  /** Ms epoch of the service's last accepted event, when it has had one. */
  lastEventMs?: number;
  /** Sessions of this service that carried at least one event. */
  sessionsWithEvents: number;
  sessionsTotal: number;
}

/** Shape of the slice of `/api/stats` this module reads. */
interface StatsResponse {
  ingest?: {
    services?: Array<{
      id?: string | null;
      name?: string | null;
      lastEventAt?: string | null;
      sessionsWithEvents?: number;
      sessionsTotal?: number;
    }>;
  };
}

/**
 * Key one stats row. A session sent on a PROJECT scoped key carries no service
 * id, and the cloud reports that row with `id: null`, so falling back to the
 * name (then to a constant) keeps those rows comparable across polls instead of
 * colliding with every other unattributed row.
 */
function activityKey(row: {
  id?: string | null;
  name?: string | null;
}): string {
  return row.id ?? row.name ?? "unattributed";
}

export async function fetchIngestActivity(
  base: string,
  token: string,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<Map<string, IngestActivity>> {
  const res = await requestJson<StatsResponse>(
    `${base}/api/stats?projectId=${encodeURIComponent(projectId)}`,
    { token, fetchImpl },
  );
  const out = new Map<string, IngestActivity>();
  for (const row of res.ingest?.services ?? []) {
    const parsed = row.lastEventAt ? Date.parse(row.lastEventAt) : NaN;
    out.set(activityKey(row), {
      ...(Number.isFinite(parsed) ? { lastEventMs: parsed } : {}),
      sessionsWithEvents: row.sessionsWithEvents ?? 0,
      sessionsTotal: row.sessionsTotal ?? 0,
    });
  }
  return out;
}

/**
 * Which application (if any) reported something new since the baseline.
 *
 * Returns the key from {@link activityKey}, so the caller can attribute the
 * arrival to a service. Undefined without a baseline: a poll that never read
 * the counters before the user acted cannot tell a rise from a starting value.
 */
export function risenIngestActivityKeys(
  before: ReadonlyMap<string, IngestActivity> | undefined,
  now: ReadonlyMap<string, IngestActivity>,
): string[] {
  if (!before) return [];
  const risen: string[] = [];
  for (const [key, after] of now) {
    const prior = before.get(key);
    if (!prior) {
      // An application the project did not have before. It counts only once it
      // has actually captured something.
      if (after.sessionsWithEvents > 0 || after.lastEventMs !== undefined) {
        risen.push(key);
      }
      continue;
    }
    if (
      (after.lastEventMs !== undefined &&
        after.lastEventMs > (prior.lastEventMs ?? 0)) ||
      after.sessionsWithEvents > prior.sessionsWithEvents ||
      after.sessionsTotal > prior.sessionsTotal
    ) {
      risen.push(key);
    }
  }
  return risen;
}

/** The first application to report something new, if any. */
export function risenIngestActivity(
  before: ReadonlyMap<string, IngestActivity> | undefined,
  now: ReadonlyMap<string, IngestActivity>,
): string | undefined {
  return risenIngestActivityKeys(before, now)[0];
}

/** The pre-wait snapshot both polls anchor "what is new" against. */
interface Baseline {
  ids: Set<string>;
  activity: Map<string, SessionActivity>;
  /** Per-application ingest counters, absent when `/api/stats` could not be read. */
  ingest?: Map<string, IngestActivity>;
}

function snapshotBaseline(
  sessions: SessionRow[],
  ingest?: Map<string, IngestActivity>,
): Baseline {
  return {
    ids: new Set(sessions.map((s) => s.id)),
    activity: new Map(sessions.map((s) => [s.id, sessionActivity(s)])),
    ...(ingest ? { ingest } : {}),
  };
}

/** Best session to deep link to for an arrival the counters reported. */
function sessionForActivityKey(
  sessions: SessionRow[],
  key: string,
): string | undefined {
  const attributed = sessions.find(
    (s) => s.serviceId === key && !s.id.startsWith(CLI_CHECK_PREFIX),
  );
  const any = sessions.find((s) => !s.id.startsWith(CLI_CHECK_PREFIX));
  // The feed is newest first, so the first match is the session the arrival
  // most likely landed in.
  return (attributed ?? any)?.id;
}

export interface PollRealEventOptions {
  base: string;
  token: string;
  projectId: string;
  ui: Ui;
  /**
   * Ms epoch captured at wizard entry. Only sessions started at/after this count
   * as "the first real event" — a session from a prior run is ignored.
   */
  wizardStart?: number;
  signal?: AbortSignal;
  config?: IngestPollConfig;
  fetchImpl?: typeof fetch;
  /** Injected delay (tests); defaults to a real, abortable setTimeout. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function fetchSessions(
  base: string,
  token: string,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<SessionRow[]> {
  const res = await requestJson<{ sessions?: SessionRow[] }>(
    `${base}/api/sessions?projectId=${encodeURIComponent(projectId)}`,
    { token, fetchImpl },
  );
  return Array.isArray(res.sessions) ? res.sessions : [];
}

/**
 * Poll the sessions feed until a real (non-synthetic) session lands, the backoff
 * budget is exhausted, or the caller aborts (Ctrl-C). The timing policy is the
 * ported poll.ts state machine. On a TTY, a live elapsed-time status line keeps
 * a long wait from reading as a hang.
 */
export async function pollForRealEvent(
  opts: PollRealEventOptions,
): Promise<PollRealEventResult> {
  const config = opts.config ?? DEFAULT_INGEST_POLL_CONFIG;
  const sleep = opts.sleepFn ?? realSleep;
  opts.ui.out("");
  opts.ui.out(
    // Named as a second terminal on purpose: this one is blocked on the poll
    // below, so "start your dev server" here read as an instruction the reader
    // could not carry out, and the spinner ticking up looked like the reason.
    `${color.brand(glyphs().arrow)} ${color.bold("In another terminal, start your dev server and load a page in your browser.")}`,
  );
  // One live line for the whole wait. On a TTY it animates; everywhere else it
  // prints once and stays quiet, so a CI log gets one line rather than a
  // thousand.
  const spinner = startSpinner(
    opts.ui,
    "Waiting for the first real event… (Ctrl-C to skip)",
  );

  // Anchor "what's new" BEFORE the user acts: snapshot both the session ids
  // that already exist and what each of them has captured so far. Any session
  // absent from this baseline is genuinely new — a skew-proof signal that beats
  // comparing the cloud's `startedAt` against our local wall clock (the two
  // clocks drift independently) — and any baseline session whose counters rise
  // is the same arrival from an app that was already running when we started
  // waiting. If the snapshot read fails we degrade to the bounded-skew
  // timestamp check. Skip the snapshot entirely if we were already cancelled,
  // so an aborted poll does zero network work.
  if (opts.signal?.aborted) {
    spinner.stop();
    return { outcome: "cancelled" };
  }
  let baseline: Baseline | undefined;
  try {
    // Both reads, taken together: the session ids that already exist, and the
    // ingest counters for the applications that already report. A stats read
    // that fails leaves the counters out and the poll falls back to identity
    // alone, rather than losing the whole baseline.
    const [sessions, ingest] = await Promise.all([
      fetchSessions(opts.base, opts.token, opts.projectId, opts.fetchImpl),
      fetchIngestActivity(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      ).catch(() => undefined),
    ]);
    baseline = snapshotBaseline(sessions, ingest);
  } catch {
    baseline = undefined;
  }
  const guard: RealSessionGuard = {
    baselineIds: baseline?.ids,
    baselineActivity: baseline?.activity,
    skewToleranceMs: POLL_SKEW_TOLERANCE_MS,
  };

  let state = initialIngestPollState();
  let sessionId: string | undefined;
  // What the wait is allowed to claim afterwards. Only reads that succeeded
  // count as observation: a poll that never got an answer knows nothing about
  // whether events arrived, and must not report that as "no events".
  let readsSucceeded = baseline !== undefined;
  let lastSeenSessionCount = baseline?.ids.size;
  while (state.status === "waiting") {
    const delay = nextPollDelayMs(state, config);
    // Elapsed comes from the (pure) state machine, so the ticker is exact for
    // the budget it's counting against, not wall-clock guesswork.
    spinner.setLabel(
      `Waiting for the first real event… ${Math.round((state.elapsedMs + delay) / 1000)}s (Ctrl-C to skip)`,
    );
    await sleep(delay, opts.signal);
    if (opts.signal?.aborted) {
      spinner.stop();
      return { outcome: "cancelled" };
    }
    let found: boolean;
    try {
      const sessions = await fetchSessions(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      );
      readsSucceeded = true;
      lastSeenSessionCount = sessions.length;
      const real = firstRealSession(sessions, opts.wizardStart, guard);
      found = real !== undefined;
      if (real) sessionId = real.id;
      if (!found && baseline?.ingest) {
        // Nothing new in the feed. That is the case an app which was already
        // running produces: it keeps reporting into the session it opened at
        // boot, so no id is new and no row's counters are published while the
        // session is still open. The ingest counters are.
        const risen = risenIngestActivity(
          baseline.ingest,
          await fetchIngestActivity(
            opts.base,
            opts.token,
            opts.projectId,
            opts.fetchImpl,
          ),
        );
        if (risen) {
          found = true;
          sessionId = sessionForActivityKey(sessions, risen);
        }
      }
    } catch {
      // A transient read failure just means "not yet" — keep polling.
      found = false;
    }
    state = recordPollAttempt(state, found, delay, config);
  }
  spinner.stop();
  if (state.status === "found") return { outcome: "found", sessionId };
  const reason: PollTimeoutReason = !readsSucceeded
    ? "reads-failed"
    : (lastSeenSessionCount ?? 0) === 0
      ? "no-sessions"
      : "no-new-activity";
  return {
    outcome: "timedout",
    reason,
    ...(baseline ? { baselineSessionCount: baseline.ids.size } : {}),
  };
}

// ── Batch verification (multi-service installer) ─────────────────────────────
//
// The sessions feed is already PROJECT-scoped and already returns serviceId per
// row, so N services need exactly ONE poll — not N. Looping pollForRealEvent
// would serialize N five-minute budgets (50 minutes for 10 services); this
// shares a single budget across the whole batch and attributes arrivals as they
// land.

/**
 * Map each service to the first real session it produced. Pure — shares the
 * exact arrival test with {@link firstRealSession} (synthetic prefix, identity
 * baseline, rising event counts / bounded-skew `startedAt`), plus a skip for rows
 * the cloud didn't attribute to a service. Pass a {@link RealSessionGuard} to
 * opt into the skew-proof identity baseline; without one the behavior is the
 * legacy timestamp check.
 */
export function realSessionsByService(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): Map<string, string> {
  const found = new Map<string, string>();
  // The feed is newest-first, so walk it in reverse and keep the FIRST
  // qualifying session per service — the earliest one after the window opened,
  // i.e. the event the user just caused, not whatever happened most recently.
  for (const s of [...sessions].reverse()) {
    if (!s.serviceId || found.has(s.serviceId)) continue;
    if (!isArrival(s, wizardStart, guard)) continue;
    found.set(s.serviceId, s.id);
  }
  return found;
}

export interface PollServicesOptions extends Omit<
  PollRealEventOptions,
  "wizardStart"
> {
  wizardStart?: number;
  /** The services we just wired and expect events from. */
  serviceIds: string[];
  /** Fired once per service, the first time its event lands. */
  onFound?: (serviceId: string, sessionId: string) => void;
}

export interface PollServicesResult {
  /** "found" only when EVERY serviceId reported. */
  outcome: RealEventOutcome;
  /** serviceId → sessionId, for however many reported before we stopped. */
  found: Record<string, string>;
}

/**
 * Poll once for the whole batch until every wired service has reported, the
 * shared budget is exhausted, or the user aborts. Timeout and cancel both return
 * whatever arrived — stragglers never block the wizard from finishing, because
 * the wiring is already done by the time we get here.
 */
export async function pollForServices(
  opts: PollServicesOptions,
): Promise<PollServicesResult> {
  const config = opts.config ?? DEFAULT_INGEST_POLL_CONFIG;
  const sleep = opts.sleepFn ?? realSleep;
  const total = opts.serviceIds.length;
  const wanted = new Set(opts.serviceIds);
  const found = new Map<string, string>();

  opts.ui.out("");
  opts.ui.out(
    `${color.brand(glyphs().arrow)} ${color.bold("Now start your services so they can report in.")}`,
  );
  const spinner = startSpinner(
    opts.ui,
    "Waiting for first events… (Ctrl-C to skip)",
  );

  // The same skew-proof anchor the single-service poll takes: snapshot the ids
  // and per-session counters that already exist BEFORE the user starts
  // anything, so "new" is decided in the cloud's own id namespace and against
  // its own counters rather than by comparing its `startedAt`
  // against our local wall clock. Without it this poll fell back to a strict
  // `startedAt >= wizardStart` with zero tolerance and rejected genuine first
  // events, leaving every service reported as "No event yet" while the
  // dashboard showed the sessions. A failed snapshot degrades to the bounded
  // skew check rather than to that cliff.
  let batchBaseline: Baseline | undefined;
  try {
    const [sessions, ingest] = await Promise.all([
      fetchSessions(opts.base, opts.token, opts.projectId, opts.fetchImpl),
      fetchIngestActivity(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      ).catch(() => undefined),
    ]);
    batchBaseline = snapshotBaseline(sessions, ingest);
  } catch {
    batchBaseline = undefined;
  }
  const guard: RealSessionGuard = {
    baselineIds: batchBaseline?.ids,
    baselineActivity: batchBaseline?.activity,
    skewToleranceMs: POLL_SKEW_TOLERANCE_MS,
  };

  const sep = caps().unicode ? " · " : " | ";
  let state = initialIngestPollState();
  while (state.status === "waiting") {
    const delay = nextPollDelayMs(state, config);
    spinner.setLabel(
      `Waiting for first events… ${found.size}/${total} services${sep}${Math.round((state.elapsedMs + delay) / 1000)}s (Ctrl-C to skip)`,
    );
    await sleep(delay, opts.signal);
    if (opts.signal?.aborted) {
      spinner.stop();
      return { outcome: "cancelled", found: Object.fromEntries(found) };
    }
    try {
      const sessions = await fetchSessions(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      );
      const arrivals = realSessionsByService(sessions, opts.wizardStart, guard);
      if (batchBaseline?.ingest) {
        // The services whose ingest counters moved but whose session was
        // already open, so nothing in the feed changed for them.
        for (const key of risenIngestActivityKeys(
          batchBaseline.ingest,
          await fetchIngestActivity(
            opts.base,
            opts.token,
            opts.projectId,
            opts.fetchImpl,
          ),
        )) {
          if (arrivals.has(key)) continue;
          const sessionId = sessionForActivityKey(sessions, key);
          if (sessionId) arrivals.set(key, sessionId);
        }
      }
      for (const [serviceId, sessionId] of arrivals) {
        if (!wanted.has(serviceId) || found.has(serviceId)) continue;
        found.set(serviceId, sessionId);
        // Clear the live line before printing, or the next repaint lands on
        // top of the arrival notice.
        spinner.pause();
        opts.onFound?.(serviceId, sessionId);
        spinner.resume();
      }
    } catch {
      // A transient read failure just means "not yet" — keep polling.
    }
    // Terminal only when every service reported; otherwise ride the budget out.
    state = recordPollAttempt(state, found.size === total, delay, config);
  }
  spinner.stop();
  return {
    outcome: state.status === "found" ? "found" : "timedout",
    found: Object.fromEntries(found),
  };
}
