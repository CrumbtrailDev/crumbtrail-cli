import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGEST_POLL_CONFIG,
  initialIngestPollState,
  nextPollDelayMs,
  recordPollAttempt,
  type IngestPollConfig,
  type IngestPollState,
} from "../poll";
import {
  firstRealSession,
  hasRealSession,
  isRealNewSession,
  pollForRealEvent,
  realSessionsByService,
  CLI_CHECK_PREFIX,
  POLL_SKEW_TOLERANCE_MS,
  type SessionRow,
} from "../verify";

const silentUi = { out: () => {}, err: () => {} };

// A sleepFn that never actually waits — the poll loop's timing is driven
// entirely by the (pure) state machine, so tests fold every delay to 0ms and
// assert on attempts/outcomes instead of wall-clock time. Hermetic, no real
// timers or sleeps.
const instantSleep = async (
  _ms: number,
  _signal?: AbortSignal,
): Promise<void> => {};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

/**
 * A fetch that serves a different sessions page on each successive call (the
 * last page repeats once exhausted). Call 0 is the baseline snapshot the poll
 * takes before the loop, so later pages model sessions that ARRIVE after the
 * verify window opened.
 */
function stagedFetch(pages: SessionRow[][]): typeof fetch {
  let call = 0;
  return (async () => {
    const sessions = pages[Math.min(call++, pages.length - 1)];
    return {
      status: 200,
      text: async () => JSON.stringify({ sessions }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A fetch that throws on the first call (baseline read fails) then serves a page. */
function baselineFailsThenServes(body: unknown): typeof fetch {
  let call = 0;
  return (async () => {
    if (call++ === 0) throw new Error("baseline read boom");
    return {
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("nextPollDelayMs", () => {
  const config: IngestPollConfig = {
    initialDelayMs: 3000,
    maxDelayMs: 10000,
    timeoutMs: 60000,
  };

  it("ramps linearly from the initial delay", () => {
    const s0: IngestPollState = {
      status: "waiting",
      attempts: 0,
      elapsedMs: 0,
    };
    expect(nextPollDelayMs(s0, config)).toBe(3000);
    const s1: IngestPollState = {
      status: "waiting",
      attempts: 1,
      elapsedMs: 3000,
    };
    expect(nextPollDelayMs(s1, config)).toBe(6000);
    const s2: IngestPollState = {
      status: "waiting",
      attempts: 2,
      elapsedMs: 9000,
    };
    expect(nextPollDelayMs(s2, config)).toBe(9000);
  });

  it("caps at maxDelayMs", () => {
    const s: IngestPollState = {
      status: "waiting",
      attempts: 10,
      elapsedMs: 30000,
    };
    expect(nextPollDelayMs(s, config)).toBe(10000);
  });

  it("returns 0 for terminal states", () => {
    expect(
      nextPollDelayMs(
        { status: "found", attempts: 3, elapsedMs: 9000 },
        config,
      ),
    ).toBe(0);
    expect(
      nextPollDelayMs(
        { status: "timedout", attempts: 3, elapsedMs: 9000 },
        config,
      ),
    ).toBe(0);
  });

  it("defaults to DEFAULT_INGEST_POLL_CONFIG when no config is given", () => {
    expect(nextPollDelayMs(initialIngestPollState())).toBe(
      DEFAULT_INGEST_POLL_CONFIG.initialDelayMs,
    );
  });
});

describe("recordPollAttempt", () => {
  const config: IngestPollConfig = {
    initialDelayMs: 1000,
    maxDelayMs: 1000,
    timeoutMs: 2500,
  };

  it("transitions to found once a real session shows up", () => {
    const s0 = initialIngestPollState();
    const s1 = recordPollAttempt(s0, true, 1000, config);
    expect(s1).toEqual({ status: "found", attempts: 1, elapsedMs: 1000 });
  });

  it("keeps waiting while under the timeout budget", () => {
    const s0 = initialIngestPollState();
    const s1 = recordPollAttempt(s0, false, 1000, config);
    expect(s1).toEqual({ status: "waiting", attempts: 1, elapsedMs: 1000 });
  });

  it("times out once elapsed reaches the budget", () => {
    let state = initialIngestPollState();
    state = recordPollAttempt(state, false, 1000, config); // elapsed 1000
    state = recordPollAttempt(state, false, 1000, config); // elapsed 2000
    state = recordPollAttempt(state, false, 1000, config); // elapsed 3000 >= 2500
    expect(state).toEqual({ status: "timedout", attempts: 3, elapsedMs: 3000 });
  });

  it("freezes once terminal — a late attempt can't resurrect polling", () => {
    const found = recordPollAttempt(
      initialIngestPollState(),
      true,
      1000,
      config,
    );
    const after = recordPollAttempt(found, false, 500, config);
    expect(after).toBe(found);

    const timedout = recordPollAttempt(
      { status: "timedout", attempts: 3, elapsedMs: 3000 },
      true,
      500,
      config,
    );
    expect(timedout).toEqual({
      status: "timedout",
      attempts: 3,
      elapsedMs: 3000,
    });
  });

  it("clamps a negative waitedMs (defensive, shouldn't go backwards)", () => {
    const s = recordPollAttempt(initialIngestPollState(), false, -50, config);
    expect(s.elapsedMs).toBe(0);
  });
});

describe("hasRealSession", () => {
  it("is false for an empty list or all-synthetic sessions", () => {
    expect(hasRealSession([])).toBe(false);
    expect(hasRealSession([{ id: `${CLI_CHECK_PREFIX}abc` }])).toBe(false);
  });

  it("is true once any non-synthetic session is present", () => {
    expect(
      hasRealSession([
        { id: `${CLI_CHECK_PREFIX}abc` },
        { id: "real-session-1" },
      ]),
    ).toBe(true);
  });
});

describe("firstRealSession — wizardStart filter", () => {
  const WIZARD_START = 1_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("ignores a real session that started BEFORE wizardStart", () => {
    const stale = { id: "prior-run", startedAt: iso(WIZARD_START - 1) };
    expect(firstRealSession([stale], WIZARD_START)).toBeUndefined();
    expect(hasRealSession([stale], WIZARD_START)).toBe(false);
  });

  it("accepts a real session started at/after wizardStart", () => {
    const fresh = { id: "this-run", startedAt: iso(WIZARD_START + 5) };
    expect(firstRealSession([fresh], WIZARD_START)?.id).toBe("this-run");
  });

  it("skips the stale row and returns the fresh one when both are present", () => {
    const sessions = [
      { id: `${CLI_CHECK_PREFIX}synthetic`, startedAt: iso(WIZARD_START + 1) },
      { id: "prior-run", startedAt: iso(WIZARD_START - 10_000) },
      { id: "this-run", startedAt: iso(WIZARD_START + 10) },
    ];
    expect(firstRealSession(sessions, WIZARD_START)?.id).toBe("this-run");
  });

  it("falls back to the legacy (no-filter) behavior when wizardStart is omitted", () => {
    const sessions = [{ id: "prior-run", startedAt: iso(WIZARD_START - 1) }];
    expect(firstRealSession(sessions)?.id).toBe("prior-run");
  });
});

describe("pollForRealEvent", () => {
  const fastConfig: IngestPollConfig = {
    initialDelayMs: 1,
    maxDelayMs: 1,
    timeoutMs: 2,
  };

  it("returns 'cancelled' as soon as the signal aborts, without waiting out the budget", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      return {
        status: 200,
        text: async () => JSON.stringify({ sessions: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      signal: controller.signal,
      config: fastConfig,
      sleepFn: instantSleep,
      fetchImpl,
    });

    expect(outcome).toEqual({ outcome: "cancelled" });
    expect(fetchCalls).toBe(0);
  });

  it("returns 'timedout' once the backoff budget is exhausted with no real session", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ sessions: [{ id: `${CLI_CHECK_PREFIX}only` }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      config: fastConfig,
      sleepFn: instantSleep,
      fetchImpl,
    });

    expect(outcome).toEqual({ outcome: "timedout" });
    // 1 baseline snapshot + two 1ms poll attempts reaching the 2ms budget.
    expect(fetchCalls).toBe(3);
  });

  it("returns 'found' with the real session's id once one appears", async () => {
    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      config: fastConfig,
      sleepFn: instantSleep,
      // Baseline snapshot (call 0) holds only the synthetic marker; the real
      // session lands on the next page, so identity flags it as new.
      fetchImpl: stagedFetch([
        [{ id: `${CLI_CHECK_PREFIX}abc` }],
        [{ id: `${CLI_CHECK_PREFIX}abc` }, { id: "real-session-1" }],
      ]),
    });

    expect(outcome).toEqual({ outcome: "found", sessionId: "real-session-1" });
  });

  it("does not accept a stale pre-wizardStart session (wizardStart filter)", async () => {
    const wizardStart = 2_000_000;
    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      wizardStart,
      config: fastConfig,
      sleepFn: instantSleep,
      fetchImpl: fakeFetch({
        sessions: [
          {
            id: "prior-run",
            startedAt: new Date(wizardStart - 60_000).toISOString(),
          },
        ],
      }),
    });
    // The only real session predates the wizard → never "found".
    // (Now enforced by the identity baseline: prior-run is in the snapshot.)
    expect(outcome).toEqual({ outcome: "timedout" });
  });
});

// ── Clock-skew hardening ─────────────────────────────────────────────────────
//
// `wizardStart` is captured from the LOCAL machine clock; `startedAt` is stamped
// by the CLOUD. A strict `startedAt >= wizardStart` compares two unsynchronized
// clocks, so a real event can be dropped (cloud behind) or a stale one accepted
// (cloud ahead). These tests pin the two defenses: the identity baseline (never
// compares clocks) and the bounded skew tolerance on the timestamp fallback.

describe("isRealNewSession — identity baseline (skew-proof)", () => {
  const WIZARD_START = 2_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("rejects a pre-existing session even when the cloud clock runs AHEAD (stale startedAt looks fresh)", () => {
    // Cloud ahead: a session from a prior run gets a startedAt AFTER our local
    // wizardStart. Timestamps alone would wrongly accept it; identity does not.
    const stale: SessionRow = {
      id: "prior-run",
      startedAt: iso(WIZARD_START + 5 * 60_000),
    };
    const guard = { baselineIds: new Set(["prior-run"]) };
    expect(isRealNewSession(stale, WIZARD_START, guard)).toBe(false);
  });

  it("accepts a genuinely new session even when the cloud clock runs BEHIND (fresh startedAt looks stale)", () => {
    // Cloud behind: the user's new session is stamped BEFORE wizardStart.
    // Timestamps alone would wrongly reject it; identity accepts it (new id).
    const fresh: SessionRow = {
      id: "this-run",
      startedAt: iso(WIZARD_START - 5 * 60_000),
    };
    const guard = { baselineIds: new Set(["prior-run"]) };
    expect(isRealNewSession(fresh, WIZARD_START, guard)).toBe(true);
  });

  it("accepts a new session when clocks are EQUAL", () => {
    const s: SessionRow = { id: "this-run", startedAt: iso(WIZARD_START) };
    const guard = { baselineIds: new Set<string>() }; // empty baseline
    expect(isRealNewSession(s, WIZARD_START, guard)).toBe(true);
  });

  it("still rejects the synthetic marker regardless of baseline", () => {
    const synthetic: SessionRow = { id: `${CLI_CHECK_PREFIX}xyz` };
    const guard = { baselineIds: new Set<string>() };
    expect(isRealNewSession(synthetic, WIZARD_START, guard)).toBe(false);
  });
});

describe("isRealNewSession — timestamp fallback (no baseline)", () => {
  const WIZARD_START = 2_000_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const withTolerance = { skewToleranceMs: POLL_SKEW_TOLERANCE_MS };

  it("accepts a real event whose startedAt is slightly before wizardStart (cloud behind, within tolerance)", () => {
    const s: SessionRow = { id: "s", startedAt: iso(WIZARD_START - 30_000) };
    expect(isRealNewSession(s, WIZARD_START, withTolerance)).toBe(true);
  });

  it("rejects a session older than the bounded tolerance (cannot resurrect a prior run)", () => {
    const tooOld = iso(WIZARD_START - (POLL_SKEW_TOLERANCE_MS + 60_000));
    const s: SessionRow = { id: "s", startedAt: tooOld };
    expect(isRealNewSession(s, WIZARD_START, withTolerance)).toBe(false);
  });

  it("accepts equal and cloud-ahead timestamps", () => {
    expect(
      isRealNewSession(
        { id: "eq", startedAt: iso(WIZARD_START) },
        WIZARD_START,
        withTolerance,
      ),
    ).toBe(true);
    expect(
      isRealNewSession(
        { id: "ahead", startedAt: iso(WIZARD_START + 30_000) },
        WIZARD_START,
        withTolerance,
      ),
    ).toBe(true);
  });

  it("keeps the exact hard cliff when no tolerance is supplied (default 0)", () => {
    const justBefore: SessionRow = {
      id: "s",
      startedAt: iso(WIZARD_START - 1),
    };
    expect(isRealNewSession(justBefore, WIZARD_START)).toBe(false);
    expect(
      isRealNewSession(
        { id: "s2", startedAt: iso(WIZARD_START) },
        WIZARD_START,
      ),
    ).toBe(true);
  });
});

describe("realSessionsByService — identity baseline", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const WIZARD_START = 2_000_000;

  it("attributes only sessions absent from the baseline, ignoring startedAt skew", () => {
    const rows: SessionRow[] = [
      // Pre-existing, but stamped in the FUTURE (cloud ahead) — must be ignored.
      {
        id: "old-api",
        serviceId: "svc-api",
        startedAt: iso(WIZARD_START + 60_000),
      },
      // Genuinely new, but stamped in the PAST (cloud behind) — must be kept.
      {
        id: "new-web",
        serviceId: "svc-web",
        startedAt: iso(WIZARD_START - 60_000),
      },
    ];
    const guard = { baselineIds: new Set(["old-api"]) };
    const found = realSessionsByService(rows, WIZARD_START, guard);
    expect(found.has("svc-api")).toBe(false);
    expect(found.get("svc-web")).toBe("new-web");
  });
});

describe("pollForRealEvent — skew hardening", () => {
  const fastConfig: IngestPollConfig = {
    initialDelayMs: 1,
    maxDelayMs: 1,
    timeoutMs: 2,
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const WIZARD_START = 2_000_000;

  it("identity baseline beats a misleading startedAt: finds the NEW session (past ts) and ignores a PRE-EXISTING one (future ts)", async () => {
    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      wizardStart: WIZARD_START,
      config: fastConfig,
      sleepFn: instantSleep,
      fetchImpl: stagedFetch([
        // Baseline: a pre-existing session with a deceptively FUTURE timestamp.
        [{ id: "old-sess", startedAt: iso(WIZARD_START + 300_000) }],
        // The user's real event arrives with a deceptively PAST timestamp.
        [
          { id: "old-sess", startedAt: iso(WIZARD_START + 300_000) },
          { id: "new-sess", startedAt: iso(WIZARD_START - 300_000) },
        ],
      ]),
    });
    expect(outcome).toEqual({ outcome: "found", sessionId: "new-sess" });
  });

  it("degrades to bounded-tolerance timestamps when the baseline read fails (cloud behind, within tolerance)", async () => {
    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      wizardStart: WIZARD_START,
      config: fastConfig,
      sleepFn: instantSleep,
      // Baseline read throws → no identity anchor → tolerant timestamp path.
      fetchImpl: baselineFailsThenServes({
        sessions: [{ id: "s1", startedAt: iso(WIZARD_START - 30_000) }],
      }),
    });
    expect(outcome).toEqual({ outcome: "found", sessionId: "s1" });
  });

  it("degraded fallback stays bounded: a session older than the tolerance times out", async () => {
    const outcome = await pollForRealEvent({
      base: "http://example.invalid",
      token: "tok",
      projectId: "p1",
      ui: silentUi,
      wizardStart: WIZARD_START,
      config: fastConfig,
      sleepFn: instantSleep,
      fetchImpl: baselineFailsThenServes({
        sessions: [
          {
            id: "s1",
            startedAt: iso(WIZARD_START - (POLL_SKEW_TOLERANCE_MS + 60_000)),
          },
        ],
      }),
    });
    expect(outcome).toEqual({ outcome: "timedout" });
  });
});
