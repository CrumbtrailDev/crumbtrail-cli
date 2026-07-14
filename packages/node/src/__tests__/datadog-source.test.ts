import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  DatadogEvidenceSource,
  buildDatadogQuery,
  datadogAppBase,
  normalizeDatadogLog,
  normalizeDatadogSpan,
  datadogEvidenceProvider,
  DATADOG_API_KEY_ENV,
  DATADOG_APP_KEY_ENV,
  DATADOG_SITE_ENV,
  DATADOG_DESCRIPTOR,
  type DatadogLog,
  type DatadogSpan,
} from "../evidence-sources/datadog";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import logsSearch from "./fixtures/evidence-sources/datadog/logs-search.json";
import spansSearch from "./fixtures/evidence-sources/datadog/spans-search.json";

const WINDOW = {
  start: Date.parse("2026-07-08T00:00:00.000Z"),
  end: Date.parse("2026-07-08T23:59:59.000Z"),
};
const LIMITS = { maxItems: 50, maxBytes: 1_000_000, timeoutMs: 10_000 };

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * A fixture-replaying transport routed by URL path. NO network: it returns the
 * recorded logs / spans samples and records every request (to assert the
 * DD-API-KEY/DD-APPLICATION-KEY headers + UA + query body reached the wire).
 * `slowSpans` makes the spans endpoint hang until its abort signal fires, so the
 * secondary-budget resilience path can be exercised deterministically.
 */
function fakeDatadog(
  options: { failLogs?: boolean; slowSpans?: boolean } = {},
) {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, method, headers, body });

    const json = async (data: unknown) => data;
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: () => json(data),
    });

    if (url.endsWith("/api/v1/validate")) return ok({ valid: true });

    if (url.includes("/api/v2/logs/events/search")) {
      if (options.failLogs)
        return { ok: false, status: 403, json: () => json({}) };
      return ok(logsSearch);
    }

    if (url.includes("/api/v2/spans/events/search")) {
      if (options.slowSpans) {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(abortError());
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      }
      return ok(spansSearch);
    }

    return { ok: false, status: 404, json: () => json({}) };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(
  opts: { failLogs?: boolean; slowSpans?: boolean; site?: string } = {},
) {
  const fake = fakeDatadog(opts);
  const source = new DatadogEvidenceSource({
    apiKey: "dd-api-key-secret",
    appKey: "dd-app-key-secret",
    site: opts.site,
    fetchImpl: fake.fetchImpl,
  });
  return { source, requests: fake.requests };
}

describe("buildDatadogQuery — descriptor-keyed construction", () => {
  it("uses @trace_id when a trace is present", () => {
    const plan = buildDatadogQuery(
      query({ keys: { traceId: "trace-abc-123" } }),
    );
    expect(plan.usedKeys).toEqual(["traceId"]);
    expect(plan.queryString).toBe("@trace_id:trace-abc-123");
    expect(plan.gaps).toEqual([]);
  });

  it("applies service and url as declared join keys (never a no-op)", () => {
    const plan = buildDatadogQuery(
      query({
        keys: {
          traceId: "t-1",
          service: "checkout",
          url: "https://x/pay?id=1",
        },
      }),
    );
    expect(plan.usedKeys).toEqual(["traceId", "service", "url"]);
    expect(plan.queryString).toContain("service:checkout");
    expect(plan.queryString).toContain('@http.url:"https://x/pay?id=1"');
  });

  it("uses service/url alone when no trace is present", () => {
    const plan = buildDatadogQuery(query({ keys: { service: "checkout" } }));
    expect(plan.usedKeys).toEqual(["service"]);
    expect(plan.queryString).toBe("service:checkout");
  });

  it("emits a time-only gap when no supported key is present", () => {
    const plan = buildDatadogQuery(query({ keys: {} }));
    expect(plan.usedKeys).toEqual([]);
    expect(plan.queryString).toBe("");
    expect(
      plan.gaps.some((g) => g.reason.includes("no supported correlation key")),
    ).toBe(true);
  });

  it("emits a per-key gap when a requested key is unsupported (sessionId)", () => {
    const plan = buildDatadogQuery(query({ keys: { sessionId: "s-1" } }));
    expect(
      plan.gaps.some(
        (g) =>
          g.reason ===
          "datadog: cannot filter by sessionId; used time window only",
      ),
    ).toBe(true);
  });
});

describe("normalize* — the template shapes", () => {
  const appBase = datadogAppBase("datadoghq.com");

  it("maps a Datadog log to the exact evidence.v1 shape (lane logs)", () => {
    const item = normalizeDatadogLog(
      logsSearch.data[0] as DatadogLog,
      appBase,
      "@trace_id:trace-abc-123",
      WINDOW,
    );
    expect(item).toMatchObject({
      lane: "logs",
      kind: "datadog.log",
      before: null,
      ref: { provider: "datadog", id: "AAAAAaEXAMPLElogid1" },
      whenObserved: Date.parse("2026-07-08T12:34:56.789Z"),
    });
    expect(item.id).toBe("datadog:log:AAAAAaEXAMPLElogid1");
    expect(item.brief.length).toBeLessThanOrEqual(141);
    expect(item.ref.url).toContain("/logs?query=");
    expect(item.ref.url).toContain("event=AAAAAaEXAMPLElogid1");
  });

  it("maps a Datadog span to the exact evidence.v1 shape (lane network)", () => {
    const item = normalizeDatadogSpan(
      spansSearch.data[0] as DatadogSpan,
      appBase,
    );
    expect(item).toMatchObject({
      lane: "network",
      kind: "datadog.span",
      before: null,
      ref: { provider: "datadog", id: "AAAAAaEXAMPLEspanid1" },
    });
    expect(item.brief).toContain("POST /api/checkout");
    expect(item.brief).toContain("1284ms");
    // Trace deep link lands on the actual trace/span in APM.
    expect(item.ref.url).toContain("/apm/trace/trace-abc-123");
    expect(item.ref.url).toContain("spanID=span-xyz-789");
    expect(item.whenObserved).toBe(1783168496789);
  });

  it("derives the app base per site", () => {
    expect(datadogAppBase("datadoghq.com")).toBe("https://app.datadoghq.com");
    expect(datadogAppBase("datadoghq.eu")).toBe("https://app.datadoghq.eu");
    expect(datadogAppBase("us3.datadoghq.com")).toBe(
      "https://us3.datadoghq.com",
    );
  });
});

describe("DatadogEvidenceSource.fetchEvidence — end to end (fixtures)", () => {
  it("returns logs + spans, keys+UA on every request, query body on the wire", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { traceId: "trace-abc-123" } }),
    );

    // 2 logs (logs lane) + 1 span (network lane).
    expect(result.items.filter((i) => i.kind === "datadog.log")).toHaveLength(
      2,
    );
    expect(result.items.filter((i) => i.kind === "datadog.span")).toHaveLength(
      1,
    );
    expect(result.stats).toMatchObject({
      provider: "datadog",
      fetched: 3,
      returned: 3,
    });

    const logsReq = requests.find((r) =>
      r.url.includes("/logs/events/search"),
    )!;
    expect((logsReq.body.filter as Record<string, unknown>).query).toBe(
      "@trace_id:trace-abc-123",
    );
    expect((logsReq.body.filter as Record<string, unknown>).from).toBe(
      String(WINDOW.start),
    );

    const spansReq = requests.find((r) =>
      r.url.includes("/spans/events/search"),
    )!;
    const attrs = (spansReq.body.data as Record<string, unknown>)
      .attributes as Record<string, unknown>;
    expect((attrs.filter as Record<string, unknown>).query).toBe(
      "@trace_id:trace-abc-123",
    );

    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers["DD-API-KEY"]).toBe("dd-api-key-secret");
      expect(req.headers["DD-APPLICATION-KEY"]).toBe("dd-app-key-secret");
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
    expect(result.stats.fetched).toBe(3);
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

  it("re-throws a primary (logs) failure so the framework makes it a gap", async () => {
    const { source } = makeSource({ failLogs: true });
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { traceId: "t-1" } }),
    );
    expect(out.items).toHaveLength(0);
    expect(
      out.gaps.some((g) => g.reason.includes("datadog: fetch failed")),
    ).toBe(true);
    const stat = out.stats.find((s) => s.provider === "datadog");
    expect(stat?.ok).toBe(false);
    expect(stat?.error).not.toContain("dd-api-key-secret");
  });
});

describe("DatadogEvidenceSource — resilience / two-API fetch", () => {
  it("still returns the primary log items when the secondary span search out-runs its budget", async () => {
    const { source } = makeSource({ slowSpans: true });
    const result = await source.fetchEvidence(
      query({
        keys: { traceId: "trace-abc-123" },
        limits: { ...LIMITS, timeoutMs: 40 },
      }),
    );
    // Logs survived; spans dropped to a gap — one API's slowness never sinks the other.
    expect(result.items.filter((i) => i.kind === "datadog.log")).toHaveLength(
      2,
    );
    expect(result.items.filter((i) => i.kind === "datadog.span")).toHaveLength(
      0,
    );
    expect(
      result.gaps.some((g) =>
        g.reason.includes("span search did not complete"),
      ),
    ).toBe(true);
  });

  it("preserves the log items through fetchAdapterEvidence when spans out-run the framework timeout", async () => {
    const { source } = makeSource({ slowSpans: true });
    const out = await fetchAdapterEvidence(
      [source],
      query({
        keys: { traceId: "trace-abc-123" },
        limits: { ...LIMITS, timeoutMs: 80 },
      }),
    );
    expect(out.items.filter((i) => i.kind === "datadog.log")).toHaveLength(2);
    const stat = out.stats.find((s) => s.provider === "datadog");
    expect(stat?.ok).toBe(true);
  });
});

describe("DatadogEvidenceSource — health()", () => {
  it("reports ok on a 200 from validate", async () => {
    const { source, requests } = makeSource();
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "datadog" });
    expect(requests[0].url).toContain("/api/v1/validate");
  });

  it("reports a sanitized error on failure (no keys in the message)", async () => {
    const source = new DatadogEvidenceSource({
      apiKey: "dd-api-key-secret",
      appKey: "dd-app-key-secret",
      fetchImpl: (async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("403");
    expect(health.error).not.toContain("dd-api-key-secret");
    expect(health.error).not.toContain("dd-app-key-secret");
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("scrubs a token embedded in a log message body", async () => {
    const { source } = makeSource();
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { traceId: "trace-abc-123" } }),
    );
    const log = out.items.find((i) => i.kind === "datadog.log")!;
    expect(String(log.after)).not.toContain("abcdef0123456789");
    expect(String(log.after)).toContain("[REDACTED]");
    expect(log.ref.url).toContain("/logs?query=");
  });
});

describe("registry wiring", () => {
  it("declares the Datadog descriptor", () => {
    expect(DATADOG_DESCRIPTOR).toMatchObject({
      provider: "datadog",
      displayName: "Datadog",
      lanes: ["logs", "network"],
      joinKeys: ["traceId", "time", "service", "url"],
    });
  });

  it("evidenceSourcesFromEnv returns a Datadog source when its env vars are set", () => {
    registerEvidenceProvider(datadogEvidenceProvider); // idempotent
    const env = {
      [DATADOG_API_KEY_ENV]: "api",
      [DATADOG_APP_KEY_ENV]: "app",
      [DATADOG_SITE_ENV]: "datadoghq.eu",
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("datadog");
  });

  it("omits Datadog when a required var (app key) is missing", () => {
    const sources = evidenceSourcesFromEnv({ [DATADOG_API_KEY_ENV]: "api" });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain("datadog");
  });
});
