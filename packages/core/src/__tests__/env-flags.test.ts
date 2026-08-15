/**
 * `setEnv` change-scoped deltas.
 *
 * The behaviour under test is the distinction between "the app re-declared its flags" and "a
 * flag actually moved". Before this, every `setEnv` call emitted a delta restating whatever it
 * was handed, so a reader of a captured session could not tell a route-change re-declaration
 * from a mid-session flip — which is the question a flag-caused regression asks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../bug-logger";
import { REDACTED_VALUE } from "../redaction";

function mockTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

function initLogger(transport: ReturnType<typeof mockTransport>, extra = {}) {
  return Crumbtrail.init({
    transportInstance: transport as never,
    flushIntervalMs: 100_000,
    flushBufferSize: 1000,
    ...extra,
  });
}

async function allEnvEvents(
  transport: ReturnType<typeof mockTransport>,
  logger: Crumbtrail,
): Promise<Array<{ k: string; t: number; d: Record<string, any> }>> {
  await logger.flagBug({ note: "env" });
  return sentEnvEvents(transport);
}

function sentEnvEvents(
  transport: ReturnType<typeof mockTransport>,
): Array<{ k: string; t: number; d: Record<string, any> }> {
  const sent = transport.sendBugReport.mock.calls[0][1] as Array<{
    k: string;
    t: number;
    d: Record<string, any>;
  }>;
  return sent.filter((e) => e.k === "env");
}

/**
 * Env events attributable to `setEnv` itself. `flagBug` also emits a resolved
 * `kind:'flag-snapshot'` env event at flag time; it is filtered out here so these cases stay
 * about what `setEnv` emits, and it is asserted directly against `allEnvEvents` in the
 * `flag-snapshot at flag time` block below.
 */
async function envEvents(
  transport: ReturnType<typeof mockTransport>,
  logger: Crumbtrail,
): Promise<Array<{ k: string; d: Record<string, any> }>> {
  const events = await allEnvEvents(transport, logger);
  return events.filter((e) => e.d.kind !== "flag-snapshot");
}

describe("setEnv change-scoped deltas", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Criterion 1: an identical re-declaration emits nothing at all.
  it("emits no event when the declaration changes nothing", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { newCheckout: true }, config: { region: "eu" } });
    // Byte-identical re-declaration, three times, as a route change would produce.
    logger.setEnv({ flags: { newCheckout: true }, config: { region: "eu" } });
    logger.setEnv({ flags: { newCheckout: true }, config: { region: "eu" } });
    logger.setEnv({ flags: { newCheckout: true } });

    const events = await envEvents(transport, logger);
    // Exactly the snapshot and ONE delta: the first declaration moved both keys, the three
    // re-declarations moved nothing.
    expect(events.map((e) => e.d.kind)).toEqual(["snapshot", "delta"]);

    await logger.stop();
  });

  it("treats an object-valued flag rebuilt as a fresh literal as unchanged", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { rollout: { buckets: [1, 2], enabled: true } } });
    logger.setEnv({ flags: { rollout: { buckets: [1, 2], enabled: true } } });

    const events = await envEvents(transport, logger);
    expect(events.map((e) => e.d.kind)).toEqual(["snapshot", "delta"]);

    await logger.stop();
  });

  // Criterion 2: a flip ships one key, with a normalized before/after pair.
  it("scopes the delta to the flipped key and records from/to", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({
      flags: { newCheckout: true, legacyNav: false, betaSearch: true },
    });
    logger.setEnv({ flags: { newCheckout: false } });

    const events = await envEvents(transport, logger);
    expect(events.map((e) => e.d.kind)).toEqual(["snapshot", "delta", "delta"]);

    const flip = events[2].d;
    // Only the flipped key rides the wire, not the two untouched flags.
    expect(Object.keys(flip.flags)).toEqual(["newCheckout"]);
    expect(flip.flags.newCheckout).toBe(false);
    // A1 carries the NORMALIZED record, not the bare value.
    expect(flip.flagChanges).toEqual({
      newCheckout: { from: { value: true }, to: { value: false } },
    });

    await logger.stop();
  });

  it("reports a newly declared flag as an addition with an absent from", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { newCheckout: true } });
    logger.setEnv({ flags: { betaSearch: "v2" } });

    const events = await envEvents(transport, logger);
    const added = events[2].d;
    expect(Object.keys(added.flags)).toEqual(["betaSearch"]);
    // `from` is absent, not null: the key did not exist before.
    expect(added.flagChanges.betaSearch.to).toEqual({ value: "v2" });
    expect("from" in added.flagChanges.betaSearch).toBe(true);
    expect(added.flagChanges.betaSearch.from).toBeUndefined();

    await logger.stop();
  });

  // Criterion 3: a variant change over an unchanged value still registers.
  it("registers a variant change when the value is unchanged", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { checkoutCopy: { value: "on", variant: "a" } } });
    logger.setEnv({ flags: { checkoutCopy: { value: "on", variant: "b" } } });

    const events = await envEvents(transport, logger);
    expect(events.map((e) => e.d.kind)).toEqual(["snapshot", "delta", "delta"]);

    const variantFlip = events[2].d;
    expect(Object.keys(variantFlip.flags)).toEqual(["checkoutCopy"]);
    expect(variantFlip.flagChanges).toEqual({
      checkoutCopy: {
        from: { value: "on", variant: "a" },
        to: { value: "on", variant: "b" },
      },
    });

    await logger.stop();
  });

  // Criterion 4: the one whose failure is a secret leak.
  it("redacts secret-shaped values inside flagChanges from/to", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { apiKey: "sk_fake_abcdefghijklmnopqrstuvwx" } });
    logger.setEnv({ flags: { apiKey: "sk_fake_zyxwvutsrqponmlkjihgfe" } });

    const events = await envEvents(transport, logger);
    const serialized = JSON.stringify(events);
    // The old value AND the new one. `from` is the side a naive implementation forgets.
    expect(serialized).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx");
    expect(serialized).not.toContain("sk_fake_zyxwvutsrqponmlkjihgfe");

    const rotation = events[2].d;
    expect(rotation.flagChanges.apiKey.from.value).toBe(REDACTED_VALUE);
    expect(rotation.flagChanges.apiKey.to.value).toBe(REDACTED_VALUE);
    expect(rotation.flags.apiKey).toBe(REDACTED_VALUE);
    // The change record keeps its shape: a sensitive flag NAME must not collapse the whole
    // `{ from, to }` wrapper to the placeholder string.
    expect(Object.keys(rotation.flagChanges.apiKey).sort()).toEqual([
      "from",
      "to",
    ]);
    // Redaction evidence is attached and names the key once, not once per place it appears.
    const paths = (rotation.redaction.fields as Array<{ path: string }>).map(
      (f) => f.path,
    );
    expect(paths.filter((p) => p === "env.flags.apiKey")).toHaveLength(1);

    await logger.stop();
  });

  it("keeps the variant while redacting the value it produced", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({
      flags: {
        apiKey: { value: "sk_fake_abcdefghijklmnopqrstuvwx", variant: "old" },
      },
    });
    logger.setEnv({
      flags: {
        apiKey: { value: "sk_fake_zyxwvutsrqponmlkjihgfe", variant: "new" },
      },
    });

    const events = await envEvents(transport, logger);
    expect(events[2].d.flagChanges.apiKey).toEqual({
      from: { value: REDACTED_VALUE, variant: "old" },
      to: { value: REDACTED_VALUE, variant: "new" },
    });

    await logger.stop();
  });

  // Criterion 5: pre-snapshot calls fold into the snapshot and emit nothing.
  it("folds a pre-snapshot setEnv into the snapshot without emitting", async () => {
    const transport = mockTransport();
    // `environment: false` means the snapshot is never emitted, so `envEmitted` stays false —
    // the same guard a `setEnv` racing the collector hits.
    const logger = initLogger(transport, { environment: false });

    logger.setEnv({ flags: { newCheckout: true } });
    logger.setEnv({ flags: { newCheckout: false } });

    const events = await envEvents(transport, logger);
    expect(events).toEqual([]);

    await logger.stop();
  });

  it("carries the pre-snapshot declaration into a later real change", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    // Declared state accumulates from the very first call, so a later flip diffs against it
    // rather than reporting an addition.
    logger.setEnv({ flags: { newCheckout: true } });
    logger.setEnv({ flags: { newCheckout: false } });

    const events = await envEvents(transport, logger);
    expect(events[2].d.flagChanges.newCheckout).toEqual({
      from: { value: true },
      to: { value: false },
    });

    await logger.stop();
  });

  it("does not report untouched flags as removals on a partial declaration", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { a: 1, b: 2, c: 3 } });
    logger.setEnv({ flags: { b: 99 } });

    const events = await envEvents(transport, logger);
    const partial = events[2].d;
    // `diffFlags` reports removals when `next` is authoritative. `setEnv` merges, so it is fed
    // the post-merge state — `a` and `c` must not appear as `to: undefined`.
    expect(Object.keys(partial.flagChanges)).toEqual(["b"]);
    expect(Object.keys(partial.flags)).toEqual(["b"]);

    await logger.stop();
  });

  it("emits a config-only delta with no flagChanges", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { newCheckout: true }, config: { region: "eu" } });
    logger.setEnv({ config: { region: "us" } });

    const events = await envEvents(transport, logger);
    const configOnly = events[2].d;
    expect(configOnly.config).toEqual({ region: "us" });
    expect(configOnly.flags).toBeUndefined();
    expect(configOnly.flagChanges).toBeUndefined();

    await logger.stop();
  });
});

/**
 * A resolved flag snapshot at flag time.
 *
 * The session-start snapshot plus deltas answers "what were the flags at t0". It does not
 * answer "what were the flags at the moment this broke" without a reader replaying every delta
 * by hand. Emitting the resolved state at `flaggedAt` puts the answer next to the evidence.
 */
describe("flag-snapshot at flag time", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Criterion 1: exactly one, at `flaggedAt`.
  it("emits exactly one flag-snapshot, stamped at flaggedAt", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);
    // A state provider snapshot is stamped `flaggedAt` by the same finalizer, so its `t` is an
    // exact reference for flag time that does not depend on the clock source.
    logger.registerStateProvider("checkout", () => ({ step: 2 }));

    logger.setEnv({ flags: { newCheckout: true } });
    logger.setEnv({ flags: { betaSearch: "v2" } });

    await logger.flagBug({ note: "env" });
    const sent = transport.sendBugReport.mock.calls[0][1] as Array<{
      k: string;
      t: number;
      d: Record<string, any>;
    }>;
    const snapshots = sent.filter(
      (e) => e.k === "env" && e.d.kind === "flag-snapshot",
    );
    expect(snapshots).toHaveLength(1);

    const stateSnap = sent.find((e) => e.k === "state.snap");
    expect(stateSnap).toBeDefined();
    expect(snapshots[0].t).toBe(stateSnap!.t);

    await logger.stop();
  });

  // Criterion 2: RESOLVED state, not the initial declaration.
  it("carries the post-delta resolved state, not the first declaration", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({
      flags: { newCheckout: true, legacyNav: false },
      config: { region: "eu" },
    });
    logger.setEnv({ flags: { newCheckout: false }, config: { region: "us" } });

    const events = await allEnvEvents(transport, logger);
    const snapshot = events.find((e) => e.d.kind === "flag-snapshot")!.d;

    // The flipped key reads its POST-delta value...
    expect(snapshot.flags.newCheckout).toBe(false);
    expect(snapshot.config.region).toBe("us");
    // ...and the untouched key is still present, so this is the whole resolved state rather
    // than the change-scoped set a delta carries.
    expect(snapshot.flags.legacyNav).toBe(false);
    expect(Object.keys(snapshot.flags).sort()).toEqual([
      "legacyNav",
      "newCheckout",
    ]);

    await logger.stop();
  });

  it("redacts secret-shaped flag values in the snapshot", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ flags: { apiKey: "sk_fake_abcdefghijklmnopqrstuvwx" } });

    const events = await allEnvEvents(transport, logger);
    const snapshot = events.find((e) => e.d.kind === "flag-snapshot")!.d;
    expect(snapshot.flags.apiKey).toBe(REDACTED_VALUE);
    expect(JSON.stringify(snapshot)).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwx",
    );

    await logger.stop();
  });

  // Criterion 3: nothing declared means nothing emitted.
  it("emits no flag-snapshot when neither flags nor config were declared", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    const events = await allEnvEvents(transport, logger);
    expect(events.map((e) => e.d.kind)).toEqual(["snapshot"]);

    await logger.stop();
  });

  it("emits a config-only flag-snapshot when only config was declared", async () => {
    const transport = mockTransport();
    const logger = initLogger(transport);

    logger.setEnv({ config: { region: "eu" } });

    const events = await allEnvEvents(transport, logger);
    const snapshot = events.find((e) => e.d.kind === "flag-snapshot")!.d;
    expect(snapshot.config).toEqual({ region: "eu" });
    expect(snapshot.flags).toBeUndefined();

    await logger.stop();
  });

  // Criterion 4: the finalizer path drops events that do not bypass admission, so a
  // flag-snapshot without `bypassAdmission` vanishes in exactly the case it was built for.
  it("survives the flight recorder finalization path", async () => {
    vi.useFakeTimers();
    const transport = mockTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport as never,
      flightRecorder: true,
      flightRecorderTailMs: 10,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.setEnv({ flags: { newCheckout: true } });
    logger.setEnv({ flags: { newCheckout: false } });

    const report = logger.flagBug({ note: "env" });
    await vi.advanceTimersByTimeAsync(10);
    await report;

    const snapshots = sentEnvEvents(transport).filter(
      (e) => e.d.kind === "flag-snapshot",
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].d.flags).toEqual({ newCheckout: false });

    await logger.stop();
  });
});
