import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  SplunkEvidenceSource,
  buildSplunkQuery,
  normalizeSplunkRow,
  splunkSearchDeepLink,
  splunkWebBase,
  splunkEvidenceProvider,
  SPLUNK_HOST_ENV,
  SPLUNK_TOKEN_ENV,
  SPLUNK_INDEX_ENV,
  SPLUNK_WEB_URL_ENV,
  SPLUNK_DESCRIPTOR,
  type SplunkResultRow,
} from "../evidence-sources/splunk";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import createJob from "./fixtures/evidence-sources/splunk/create-job.json";
import resultsPartial from "./fixtures/evidence-sources/splunk/results-preview-partial.json";
import resultsFinal from "./fixtures/evidence-sources/splunk/results-final.json";

const WINDOW = {
  start: Date.parse("2026-07-08T00:00:00.000Z"),
  end: Date.parse("2026-07-08T23:59:59.000Z"),
};
const LIMITS = { maxItems: 50, maxBytes: 1_000_000, timeoutMs: 10_000 };
const HOST = "https://splunk.example.com:8089";
const INDEXES = ["main"];

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A fixture-replaying transport routed by URL path. NO network: it returns the
 * recorded createJob / results_preview samples and records every request (to
 * assert Bearer auth + UA + the SPL body reached the wire).
 */
function fakeSplunk(
  options: { mode?: "complete" | "running"; failCreate?: boolean } = {},
) {
  const mode = options.mode ?? "complete";
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      headers,
      body: init?.body ? String(init.body) : undefined,
    });

    const json = async (data: unknown) => data;
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: () => json(data),
    });

    if (url.includes("/services/server/info")) return ok({ generator: {} });

    if (url.includes("/services/search/v2/jobs") && method === "POST") {
      if (options.failCreate) {
        return { ok: false, status: 400, json: () => json({}) };
      }
      return ok(createJob);
    }

    if (url.includes("/results_preview")) {
      return ok(mode === "running" ? resultsPartial : resultsFinal);
    }

    return { ok: false, status: 404, json: () => json({}) };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(
  opts: {
    mode?: "complete" | "running";
    failCreate?: boolean;
    indexes?: string[];
    pollIntervalMs?: number;
    webUrl?: string;
  } = {},
) {
  const fake = fakeSplunk(opts);
  const source = new SplunkEvidenceSource({
    host: HOST,
    token: "super-secret-splunk-token",
    indexes: opts.indexes ?? INDEXES,
    webUrl: opts.webUrl,
    fetchImpl: fake.fetchImpl,
    pollIntervalMs: opts.pollIntervalMs ?? 2,
  });
  return { source, requests: fake.requests };
}

describe("buildSplunkQuery — descriptor-keyed construction", () => {
  it("uses a traceId term (best-first over requestId)", () => {
    const plan = buildSplunkQuery(
      query({ keys: { traceId: "trace-xyz", requestId: "req_abc123" } }),
      INDEXES,
    );
    expect(plan.usedKeys).toEqual(["traceId"]);
    expect(plan.spl).toContain('"trace-xyz"');
    expect(plan.spl).not.toContain("req_abc123");
    expect(plan.gaps).toEqual([]);
  });

  it("falls back to a requestId term when no traceId is present", () => {
    const plan = buildSplunkQuery(
      query({ keys: { requestId: "req_abc123" } }),
      INDEXES,
    );
    expect(plan.usedKeys).toEqual(["requestId"]);
    expect(plan.spl).toContain('"req_abc123"');
  });

  it("applies service as a field filter (declared join key, never a no-op)", () => {
    const plan = buildSplunkQuery(
      query({ keys: { traceId: "t-1", service: "checkout" } }),
      INDEXES,
    );
    expect(plan.usedKeys).toEqual(["traceId", "service"]);
    expect(plan.spl).toContain('service="checkout"');
  });

  it("embeds the index clause and epoch earliest/latest window", () => {
    const plan = buildSplunkQuery(query(), ["main", "app"]);
    expect(plan.spl).toContain('(index="main" OR index="app")');
    expect(plan.spl).toContain(`earliest=${Math.floor(WINDOW.start / 1000)}`);
    expect(plan.spl).toContain(`latest=${Math.floor(WINDOW.end / 1000)}`);
  });

  it("escapes embedded quotes/backslashes so a value cannot break out of the term", () => {
    const plan = buildSplunkQuery(
      query({ keys: { requestId: 'a"b\\c' } }),
      INDEXES,
    );
    expect(plan.spl).toContain('"a\\"b\\\\c"');
  });

  it("emits a time-only gap when no supported key is present", () => {
    const plan = buildSplunkQuery(query({ keys: {} }), INDEXES);
    expect(plan.usedKeys).toEqual([]);
    expect(
      plan.gaps.some((g) => g.reason.includes("no supported correlation key")),
    ).toBe(true);
  });

  it("emits a per-key gap when a requested key is unsupported (sessionId)", () => {
    const plan = buildSplunkQuery(
      query({ keys: { sessionId: "s-1" } }),
      INDEXES,
    );
    expect(
      plan.gaps.some(
        (g) =>
          g.reason ===
          "splunk: cannot filter by sessionId; used time window only",
      ),
    ).toBe(true);
  });
});

describe("normalizeSplunkRow — the template shape", () => {
  const row = resultsFinal.results[0] as SplunkResultRow;
  const spl = buildSplunkQuery(
    query({ keys: { requestId: "req_abc123" } }),
    INDEXES,
  ).spl;
  const webBase = splunkWebBase(HOST);

  it("maps a Splunk result row to the exact evidence.v1 shape", () => {
    const item = normalizeSplunkRow(row, webBase, spl, WINDOW);
    expect(item).toMatchObject({
      lane: "logs",
      kind: "splunk.event",
      before: null,
      ref: { provider: "splunk", id: "0:12345" },
      whenObserved: Date.parse("2026-07-08T12:34:56.789+00:00"),
    });
    expect(item.id).toBe("splunk:0:12345");
    expect(item.brief.length).toBeLessThanOrEqual(141);
    expect(String(item.after)).toContain("checkout failed");
    expect(item.ref.url).toBe(splunkSearchDeepLink(webBase, spl, WINDOW));
  });

  it("derives a web UI base (8089 -> 8000) and builds a search deep link", () => {
    expect(splunkWebBase(HOST)).toBe("https://splunk.example.com:8000");
    const link = splunkSearchDeepLink(
      "https://splunk.example.com:8000",
      spl,
      WINDOW,
    );
    expect(link).toContain("/en-US/app/search/search?q=");
    expect(link).toContain(`earliest=${Math.floor(WINDOW.start / 1000)}`);
  });

  it("honors a configured web URL override", () => {
    expect(splunkWebBase(HOST, "https://splunk.corp.internal")).toBe(
      "https://splunk.corp.internal",
    );
  });
});

describe("SplunkEvidenceSource.fetchEvidence — end to end (fixtures)", () => {
  it("returns normalized items and Bearer+UAs every request; the SPL reaches the wire", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { requestId: "req_abc123" } }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.kind === "splunk.event")).toBe(true);
    expect(result.stats).toMatchObject({
      provider: "splunk",
      fetched: 2,
      returned: 2,
    });

    // createJob body carried the SPL with the window + term.
    const create = requests.find((r) => r.method === "POST")!;
    const spl = new URLSearchParams(create.body ?? "").get("search") ?? "";
    expect(spl).toContain('search index="main"');
    expect(spl).toContain('"req_abc123"');

    // Egress identity + Bearer auth on every call; token never on the wire.
    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers.Authorization).toBe(
        "Bearer super-secret-splunk-token",
      );
    }
  });

  it("threads the source's own gaps through (time-only)", async () => {
    const { source } = makeSource();
    const result = await source.fetchEvidence(query({ keys: {} }));
    expect(
      result.gaps.some((g) =>
        g.reason.includes("no supported correlation key"),
      ),
    ).toBe(true);
  });

  it("respects maxItems (truncates, no walk beyond it)", async () => {
    const { source } = makeSource();
    const result = await source.fetchEvidence(
      query({ limits: { ...LIMITS, maxItems: 1 } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.stats.truncated).toBe(true);
    expect(result.stats.fetched).toBe(2);
  });

  it("respects maxBytes (byte-cap truncation)", async () => {
    const { source } = makeSource();
    const first = await source.fetchEvidence(query());
    const oneByteLen = Buffer.byteLength(
      JSON.stringify(first.items[0]),
      "utf8",
    );
    const result = await source.fetchEvidence(
      query({ limits: { ...LIMITS, maxBytes: oneByteLen + 5 } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.stats.truncated).toBe(true);
  });

  it("degrades a dispatch failure to a gap (not a throw) via fetchAdapterEvidence", async () => {
    const { source } = makeSource({ failCreate: true });
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { requestId: "req_abc123" } }),
    );
    expect(out.items).toHaveLength(0);
    expect(out.gaps.some((g) => g.reason.includes("splunk"))).toBe(true);
    const stat = out.stats.find((s) => s.provider === "splunk");
    // A dispatch failure that retrieves ZERO items is a hard failure: the source
    // self-degrades to a `source-unavailable` gap and the framework reports
    // ok:false — the same health signal a throwing source would emit. (The
    // adapter still resolves rather than throwing.)
    expect(stat?.ok).toBe(false);
    expect(
      out.gaps.some(
        (g) => g.reason.includes("splunk") && g.kind === "source-unavailable",
      ),
    ).toBe(true);
  });
});

describe("SplunkEvidenceSource — resilience / self-limiting search budget", () => {
  it("returns the previewed snapshot (not empty) when the search out-runs its budget", async () => {
    const { source } = makeSource({ mode: "running", pollIntervalMs: 2 });
    const result = await source.fetchEvidence(
      query({
        keys: { requestId: "req_abc123" },
        limits: { ...LIMITS, timeoutMs: 40 },
      }),
    );
    // The partial preview snapshot still yields evidence — never zero items.
    expect(result.items).toHaveLength(1);
    expect(
      result.gaps.some((g) => g.reason.includes("did not complete within")),
    ).toBe(true);
  });

  it("preserves partial items through fetchAdapterEvidence when polling out-runs the framework timeout", async () => {
    const { source } = makeSource({ mode: "running", pollIntervalMs: 2 });
    const out = await fetchAdapterEvidence(
      [source],
      query({
        keys: { requestId: "req_abc123" },
        limits: { ...LIMITS, timeoutMs: 80 },
      }),
    );
    expect(out.items).toHaveLength(1);
    const stat = out.stats.find((s) => s.provider === "splunk");
    expect(stat?.ok).toBe(true);
    expect(stat?.returned).toBe(1);
  });
});

describe("SplunkEvidenceSource — health()", () => {
  it("reports ok on a 200 from server/info", async () => {
    const { source, requests } = makeSource();
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "splunk" });
    expect(requests[0].url).toContain("/services/server/info");
  });

  it("reports a sanitized error on failure (no token in the message)", async () => {
    const source = new SplunkEvidenceSource({
      host: HOST,
      token: "super-secret-splunk-token",
      indexes: INDEXES,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("401");
    expect(health.error).not.toContain("super-secret-splunk-token");
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("scrubs a token embedded in an event's _raw body", async () => {
    const { source } = makeSource();
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { requestId: "req_abc123" } }),
    );
    const first = out.items[0];
    expect(String(first.after)).not.toContain("abcdef0123456789");
    expect(String(first.after)).toContain("[REDACTED]");
    // The plain search deep link is preserved as provenance.
    expect(first.ref.url).toContain("/en-US/app/search/search");
  });
});

describe("registry wiring", () => {
  it("declares the Splunk descriptor", () => {
    expect(SPLUNK_DESCRIPTOR).toMatchObject({
      provider: "splunk",
      displayName: "Splunk",
      lanes: ["logs"],
      joinKeys: ["traceId", "requestId", "time", "service"],
    });
  });

  it("evidenceSourcesFromEnv returns a Splunk source when its env vars are set", () => {
    registerEvidenceProvider(splunkEvidenceProvider); // idempotent
    const env = {
      [SPLUNK_HOST_ENV]: HOST,
      [SPLUNK_TOKEN_ENV]: "token",
      [SPLUNK_INDEX_ENV]: "main,app",
      [SPLUNK_WEB_URL_ENV]: "https://splunk.example.com:8000",
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("splunk");
  });

  it("omits Splunk when a required var (index) is missing", () => {
    const sources = evidenceSourcesFromEnv({
      [SPLUNK_HOST_ENV]: HOST,
      [SPLUNK_TOKEN_ENV]: "token",
    });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain("splunk");
  });
});
