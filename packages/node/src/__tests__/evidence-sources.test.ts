import { describe, it, expect } from "vitest";
import {
  EVIDENCE_SOURCE_SCHEMA_VERSION,
  type EvidenceItem,
} from "crumbtrail-core";
import {
  EVIDENCE_SOURCE_PROVIDERS,
  evidenceRequestHeaders,
  evidenceSourcesFromEnv,
  type EvidenceSourceProvider,
} from "../evidence-sources/registry";
import {
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_SOURCE_TIMEOUT_MS,
  fetchAdapterEvidence,
} from "../evidence-sources/fetch-all";
import {
  redactEvidenceItem,
  redactSourceResult,
} from "../evidence-sources/redact";
import { FakeEvidenceSource } from "../evidence-sources/fake-source";
import { CRUMBTRAIL_USER_AGENT, withBoundedRetry } from "../ticket/clients";

const WINDOW = { start: 1_000, end: 2_000 };
const LIMITS = { maxItems: 100, maxBytes: 1_000_000, timeoutMs: 10_000 };

function query(
  overrides: Partial<Parameters<typeof fetchAdapterEvidence>[1]> = {},
) {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

function item(id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    lane: "logs",
    kind: "test.log",
    brief: `event ${id}`,
    ref: {},
    before: null,
    after: null,
    ...overrides,
  };
}

describe("evidenceSourcesFromEnv — presence logic", () => {
  const provider = (
    name: string,
    authFields: string[],
  ): EvidenceSourceProvider => ({
    provider: name,
    authFields,
    fromEnv: () => new FakeEvidenceSource({ provider: name }),
  });

  it("includes a provider only when ALL its auth fields are set", () => {
    const providers = [
      provider("sentry", ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]),
      provider("splunk", ["SPLUNK_TOKEN"]),
    ];
    const env = { SENTRY_AUTH_TOKEN: "tok", SENTRY_ORG: "acme" };
    const sources = evidenceSourcesFromEnv(env, providers);
    expect(sources.map((s) => s.descriptor.provider)).toEqual(["sentry"]);
  });

  it("omits a partially-configured provider without throwing", () => {
    const providers = [provider("sentry", ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"])];
    const sources = evidenceSourcesFromEnv(
      { SENTRY_AUTH_TOKEN: "tok" },
      providers,
    );
    expect(sources).toEqual([]);
  });

  it("treats an empty-string env var as absent", () => {
    const providers = [provider("splunk", ["SPLUNK_TOKEN"])];
    expect(evidenceSourcesFromEnv({ SPLUNK_TOKEN: "" }, providers)).toEqual([]);
  });

  it("ships an empty provider registry in CP1", () => {
    expect(EVIDENCE_SOURCE_PROVIDERS).toEqual([]);
    expect(evidenceSourcesFromEnv({})).toEqual([]);
  });
});

describe("evidenceRequestHeaders", () => {
  it("always includes the shared source-identifying User-Agent", () => {
    expect(evidenceRequestHeaders()["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
    expect(evidenceRequestHeaders({ Authorization: "Bearer x" })).toEqual({
      "User-Agent": CRUMBTRAIL_USER_AGENT,
      Authorization: "Bearer x",
    });
  });
});

describe("fetchAdapterEvidence — fan-out", () => {
  it("queries every source in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    const track = {
      onFetchStart: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      },
      onFetchEnd: () => {
        active -= 1;
      },
    };
    const sources = [
      new FakeEvidenceSource({ provider: "a", delayMs: 30, ...track }),
      new FakeEvidenceSource({ provider: "b", delayMs: 30, ...track }),
      new FakeEvidenceSource({ provider: "c", delayMs: 30, ...track }),
    ];
    await fetchAdapterEvidence(sources, query());
    expect(maxActive).toBe(3);
  });

  it("merges items and each source's own gaps, tagging stats per provider", async () => {
    const sources = [
      new FakeEvidenceSource({
        provider: "a",
        items: [item("a1"), item("a2")],
        gaps: [{ lane: "logs", reason: "a cannot filter by traceId" }],
      }),
      new FakeEvidenceSource({ provider: "b", items: [item("b1")] }),
    ];
    const out = await fetchAdapterEvidence(sources, query());
    expect(out.items.map((i) => i.id).sort()).toEqual(["a1", "a2", "b1"]);
    expect(out.gaps).toContainEqual({
      lane: "logs",
      reason: "a cannot filter by traceId",
    });
    expect(out.stats).toHaveLength(2);
    const a = out.stats.find((s) => s.provider === "a")!;
    expect(a).toMatchObject({ ok: true, fetched: 2, returned: 2 });
  });
});

describe("fetchAdapterEvidence — per-source timeout", () => {
  it("degrades a slow source to a gap and keeps the others", async () => {
    const slow = new FakeEvidenceSource({
      provider: "slow",
      neverResolves: true,
    });
    const fast = new FakeEvidenceSource({
      provider: "fast",
      items: [item("f1")],
    });
    const out = await fetchAdapterEvidence([slow, fast], query(), {
      timeoutMs: 10,
    });
    expect(out.items.map((i) => i.id)).toEqual(["f1"]);
    expect(out.gaps).toContainEqual(
      expect.objectContaining({ reason: "slow: timeout after 10ms" }),
    );
    const slowStats = out.stats.find((s) => s.provider === "slow")!;
    expect(slowStats).toMatchObject({
      ok: false,
      returned: 0,
      error: "timeout",
    });
  });

  it("uses the query timeout budget when no override is given", async () => {
    const slow = new FakeEvidenceSource({
      provider: "slow",
      neverResolves: true,
    });
    const out = await fetchAdapterEvidence(
      [slow],
      query({ limits: { ...LIMITS, timeoutMs: 10 } }),
    );
    expect(out.gaps[0].reason).toContain("slow: timeout");
    expect(out.items).toEqual([]);
  });

  it("aborts the in-flight fetch via the AbortController signal", async () => {
    let sawAbort = false;
    class AbortAware extends FakeEvidenceSource {
      async fetchEvidence(
        q: Parameters<FakeEvidenceSource["fetchEvidence"]>[0],
        signal?: AbortSignal,
      ) {
        return new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
        });
      }
    }
    const out = await fetchAdapterEvidence(
      [new AbortAware({ provider: "s" })],
      query(),
      {
        timeoutMs: 10,
      },
    );
    expect(sawAbort).toBe(true);
    expect(out.gaps[0].reason).toContain("timeout");
  });
});

describe("fetchAdapterEvidence — failure isolation", () => {
  it("never throws; a throwing source becomes a gap", async () => {
    const bad = new FakeEvidenceSource({
      provider: "bad",
      error: new Error("boom"),
    });
    const good = new FakeEvidenceSource({
      provider: "good",
      items: [item("g1")],
    });
    const out = await fetchAdapterEvidence([bad, good], query());
    expect(out.items.map((i) => i.id)).toEqual(["g1"]);
    expect(out.gaps).toContainEqual(
      expect.objectContaining({ reason: "bad: fetch failed — boom" }),
    );
    expect(out.stats.find((s) => s.provider === "bad")).toMatchObject({
      ok: false,
      error: "boom",
    });
  });

  it("redacts a secret-looking token in a thrown adapter error (gap.reason + stats.error)", async () => {
    const SECRET = "abcdef0123456789abcdef0123";
    const bad = new FakeEvidenceSource({
      provider: "leaky",
      error: new Error(`auth refused Bearer ${SECRET} at boundary`),
    });
    const out = await fetchAdapterEvidence([bad], query());

    const gap = out.gaps.find((g) => g.reason.startsWith("leaky:"))!;
    const stat = out.stats.find((s) => s.provider === "leaky")!;

    // Raw secret must not survive into the retained bundle/stats.
    expect(gap.reason).not.toContain(SECRET);
    expect(stat.error).not.toContain(SECRET);
    // Framework wording around the scrubbed payload is preserved.
    expect(gap.reason).toContain("leaky: fetch failed");
    expect(stat).toMatchObject({ ok: false });
    expect(stat.error).toBeDefined();
  });
});

describe("fetchAdapterEvidence — stats.ok health invariant", () => {
  // INVARIANT: stats.ok is false iff the source could not deliver its primary
  // evidence (zero items + hard failure), whether it threw or self-degraded.
  it("marks ok:false when a self-degraded source returns zero items + a source-unavailable gap", async () => {
    const dead = new FakeEvidenceSource({
      provider: "dead",
      items: [],
      gaps: [
        {
          lane: "logs",
          reason: "dead: fetch failed — 401 bad token",
          kind: "source-unavailable",
        },
      ],
    });
    const out = await fetchAdapterEvidence([dead], query());
    const stat = out.stats.find((s) => s.provider === "dead")!;
    // Parity with a throwing source: a total self-degraded failure is ok:false.
    expect(stat.ok).toBe(false);
    expect(stat.returned).toBe(0);
    // The sanitized failure reason is surfaced on stats.error for the health surface.
    expect(stat.error).toContain("dead: fetch failed");
  });

  it("keeps ok:true when a source returns some items alongside a secondary gap", async () => {
    const partial = new FakeEvidenceSource({
      provider: "partial",
      items: [item("p1")],
      // A secondary/enrichment gap that does NOT mark the source unavailable.
      gaps: [
        {
          lane: "logs",
          reason: "partial: cannot filter by traceId; used time window only",
        },
      ],
    });
    const out = await fetchAdapterEvidence([partial], query());
    const stat = out.stats.find((s) => s.provider === "partial")!;
    expect(stat.ok).toBe(true);
    expect(stat.returned).toBe(1);
  });

  it("keeps ok:true when a source returns items even if a source-unavailable gap is present (partial success wins)", async () => {
    // Defensive: the framework's returned>0 guard means a surviving item keeps
    // the source healthy regardless of any marker — preserving primary-survives.
    const partialWithMarker = new FakeEvidenceSource({
      provider: "resilient",
      items: [item("r1")],
      gaps: [
        {
          lane: "logs",
          reason: "resilient: one group failed",
          kind: "source-unavailable",
        },
      ],
    });
    const out = await fetchAdapterEvidence([partialWithMarker], query());
    const stat = out.stats.find((s) => s.provider === "resilient")!;
    expect(stat.ok).toBe(true);
  });

  it("keeps ok:false on the throw path (unchanged)", async () => {
    const bad = new FakeEvidenceSource({
      provider: "thrower",
      error: new Error("boom"),
    });
    const out = await fetchAdapterEvidence([bad], query());
    expect(out.stats.find((s) => s.provider === "thrower")!.ok).toBe(false);
  });

  it("keeps ok:true for a legitimately empty successful fetch (zero items, no failure marker)", async () => {
    const empty = new FakeEvidenceSource({ provider: "empty", items: [] });
    const out = await fetchAdapterEvidence([empty], query());
    expect(out.stats.find((s) => s.provider === "empty")!.ok).toBe(true);
  });
});

describe("fetchAdapterEvidence — global byte cap", () => {
  it("truncates once the cap is hit and records a gap + stats", async () => {
    // Safe prose (no token-like runs) so redaction leaves it intact and byte
    // size is predictable.
    const big = "the quick brown fox jumps over the lazy dog. ".repeat(8);
    const items = [
      item("1", { brief: big }),
      item("2", { brief: big }),
      item("3", { brief: big }),
    ];
    const perItem = Buffer.byteLength(
      JSON.stringify(redactEvidenceItem(item("1", { brief: big }))),
      "utf8",
    );
    const src = new FakeEvidenceSource({ provider: "big", items });
    // Cap admits 2 items, drops the 3rd.
    const out = await fetchAdapterEvidence([src], query(), {
      maxTotalBytes: perItem * 2 + Math.floor(perItem / 2),
    });
    expect(out.items.length).toBe(2);
    expect(out.gaps).toContainEqual(
      expect.objectContaining({
        reason: expect.stringContaining("byte cap reached"),
      }),
    );
    expect(out.stats[0]).toMatchObject({ truncated: true, returned: 2 });
    expect(out.gaps.some((g) => g.reason.includes("1 item(s) dropped"))).toBe(
      true,
    );
  });

  it("exposes sane framework defaults", () => {
    expect(DEFAULT_SOURCE_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(512 * 1024);
  });
});

describe("adapter redaction boundary", () => {
  it("scrubs secrets in brief/before/after before bundling", async () => {
    const secretItem = item("s1", {
      brief: "login failed Bearer abcdef0123456789abcdef0123",
      before: { password: "hunter2" },
      after: { note: "ok" },
    });
    const src = new FakeEvidenceSource({ provider: "s", items: [secretItem] });
    const out = await fetchAdapterEvidence([src], query());
    const got = out.items[0];
    expect(got.brief).not.toContain("abcdef0123456789");
    expect((got.before as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((got.after as Record<string, unknown>).note).toBe("ok");
    // structural correlation fields are preserved
    expect(got.id).toBe("s1");
    expect(got.lane).toBe("logs");
  });

  it("scrubs a short query-token in a URL sitting in adapter after/brief text (framework boundary, no per-adapter strip)", async () => {
    // ~12-char query secret: no Bearer/JWT/prefix, under the 32-hex / 40-alnum
    // thresholds, so ONLY the key-aware URL-query redaction can catch it.
    const tokenizedUrl = "https://cb.example.com/callback?token=abc123def456";
    const urlItem = item("u1", {
      brief: `redirect ${tokenizedUrl}`,
      after: JSON.stringify({ msg: `landed on ${tokenizedUrl}` }),
    });
    // Vanilla FakeEvidenceSource — no adapter-specific query stripping in play.
    const src = new FakeEvidenceSource({ provider: "fake", items: [urlItem] });
    const out = await fetchAdapterEvidence([src], query());
    const got = out.items[0];
    // Secret gone from BOTH free-text fields...
    expect(got.brief).not.toContain("abc123def456");
    expect(String(got.after)).not.toContain("abc123def456");
    // ...while the origin + path survive as provenance.
    expect(got.brief).toContain("cb.example.com/callback");
    expect(String(got.after)).toContain("cb.example.com/callback");
  });

  it("redactSourceResult leaves stats/schemaVersion untouched", () => {
    const result = {
      schemaVersion: EVIDENCE_SOURCE_SCHEMA_VERSION,
      items: [item("1", { brief: "Bearer abcdef0123456789abcdef0123" })],
      gaps: [
        {
          lane: "logs" as const,
          reason: "note Bearer abcdef0123456789abcdef0123",
        },
      ],
      stats: {
        provider: "x",
        fetched: 1,
        returned: 1,
        truncated: false,
        latencyMs: 5,
      },
    };
    const redacted = redactSourceResult(result);
    expect(redacted.schemaVersion).toBe(EVIDENCE_SOURCE_SCHEMA_VERSION);
    expect(redacted.stats).toEqual(result.stats);
    expect(redacted.items[0].brief).not.toContain("abcdef0123456789");
    expect(redacted.gaps[0].reason).not.toContain("abcdef0123456789");
  });
});

describe("retry helper reuse", () => {
  it("reuses the single withBoundedRetry from ticket/clients (no second helper)", async () => {
    let attempts = 0;
    const result = await withBoundedRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return "ok";
      },
      { baseDelayMs: 0 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});
