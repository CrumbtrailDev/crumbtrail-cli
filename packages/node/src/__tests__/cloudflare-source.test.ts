import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  CloudflareEvidenceSource,
  buildCloudflarePlan,
  cloudflareDatePartitions,
  cloudflareToMs,
  cloudflareEvidenceProvider,
  decodeNdjson,
  normalizeCloudflarePrefix,
  normalizeHttpRequestLine,
  normalizeWorkerTraceLine,
  parseKeyWindow,
  parseListObjectsV2,
  parseNdjsonLines,
  CLOUDFLARE_DESCRIPTOR,
  CLOUDFLARE_R2_ACCOUNT_ID_ENV,
  CLOUDFLARE_R2_ACCESS_KEY_ID_ENV,
  CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV,
  CLOUDFLARE_R2_BUCKET_ENV,
  CLOUDFLARE_R2_PREFIX_ENV,
  CLOUDFLARE_R2_DATASET_ENV,
  MAX_DATE_PARTITIONS,
  type CloudflareDataset,
} from "../evidence-sources/cloudflare";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(
    join(HERE, "fixtures", "evidence-sources", "cloudflare", name),
    "utf8",
  );

const LIST_HTTP_XML = fx("list-objects-http.xml");
const LIST_HTTP_TRUNCATED_XML = fx("list-objects-http-truncated.xml");
const LIST_WORKERS_XML = fx("list-objects-workers.xml");
const HTTP_NDJSON = fx("http-requests.ndjson");
const WORKERS_NDJSON = fx("workers-trace.ndjson");

// Incident window: an hour of 2026-07-08, inside which every fixture line falls.
const WINDOW = {
  start: Date.parse("2026-07-08T12:00:00.000Z"),
  end: Date.parse("2026-07-08T13:00:00.000Z"),
};
const FULL_DAY = {
  start: Date.parse("2026-07-08T00:00:00.000Z"),
  end: Date.parse("2026-07-08T23:59:59.000Z"),
};
const LIMITS = { maxItems: 50, maxBytes: 1_000_000, timeoutMs: 10_000 };

const ACCESS_KEY = "r2-access-key-id";
const SECRET = "r2-secret-key-value-do-not-leak";

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface FakeOptions {
  dataset: CloudflareDataset;
  failList?: boolean;
  failReads?: boolean;
  slowReads?: boolean;
  /** Only the GetObject whose key url contains this substring hangs (partial). */
  slowKey?: string;
  /** ListObjectsV2 returns a page with IsTruncated=true (>1000 objects). */
  truncatedList?: boolean;
}

/**
 * A fixture-replaying R2 transport routed by URL. NO network: ListObjectsV2
 * returns the recorded XML; GetObject returns the recorded NDJSON (gzipped for
 * `.log.gz` keys, plain for `.ndjson`). Records every request so the SigV4
 * Authorization + x-amz-content-sha256 + UA headers can be asserted on the wire.
 */
function fakeR2(opts: FakeOptions) {
  const requests: RecordedRequest[] = [];
  const listXml = opts.truncatedList
    ? LIST_HTTP_TRUNCATED_XML
    : opts.dataset === "http_requests"
      ? LIST_HTTP_XML
      : LIST_WORKERS_XML;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
    });

    // ListObjectsV2 (and health) — routed by the list-type query param.
    if (url.includes("list-type=2")) {
      if (opts.failList) {
        return { ok: false, status: 403, text: async () => "<Error/>" };
      }
      return { ok: true, status: 200, text: async () => listXml };
    }

    // GetObject.
    if (opts.failReads) {
      return {
        ok: false,
        status: 403,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const hangs =
      opts.slowReads || (opts.slowKey != null && url.includes(opts.slowKey));
    if (hangs) {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    }
    const isGz = url.endsWith(".log.gz");
    const bytes = isGz
      ? gzipSync(Buffer.from(HTTP_NDJSON, "utf8"))
      : Buffer.from(WORKERS_NDJSON, "utf8");
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(opts: FakeOptions & { prefix?: string }) {
  const fake = fakeR2(opts);
  const source = new CloudflareEvidenceSource({
    accountId: "acct123",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    bucket: "cf-logs-bucket",
    prefix: opts.prefix ?? "cf-logs",
    dataset: opts.dataset,
    fetchImpl: fake.fetchImpl,
  });
  return { source, requests: fake.requests };
}

// ---------------------------------------------------------------------------

describe("buildCloudflarePlan — descriptor-keyed line filters", () => {
  it("uses requestId + url on the http_requests dataset", () => {
    const plan = buildCloudflarePlan(
      query({ keys: { requestId: "ray-1", url: "/api/checkout" } }),
      "http_requests",
    );
    expect(plan.usedKeys).toEqual(["requestId", "url"]);
    expect(plan.requestIdFilter).toBe("ray-1");
    expect(plan.urlFilter).toBe("/api/checkout");
    expect(plan.gaps).toEqual([]);
  });

  it("gaps the url key on the workers dataset (no URL field) but still uses requestId", () => {
    const plan = buildCloudflarePlan(
      query({ keys: { requestId: "ray-1", url: "/api/checkout" } }),
      "workers_trace_events",
    );
    expect(plan.usedKeys).toEqual(["requestId"]);
    expect(plan.urlFilter).toBeUndefined();
    expect(plan.gaps.some((g) => g.reason.includes("no URL field"))).toBe(true);
  });

  it("emits a per-key gap for an unsupported key (traceId)", () => {
    const plan = buildCloudflarePlan(
      query({ keys: { traceId: "t-1" } }),
      "http_requests",
    );
    expect(
      plan.gaps.some(
        (g) =>
          g.reason ===
          "cloudflare: cannot filter by traceId; used time window only",
      ),
    ).toBe(true);
  });

  it("emits a time-only gap when no supported key is present", () => {
    const plan = buildCloudflarePlan(query({ keys: {} }), "http_requests");
    expect(plan.usedKeys).toEqual([]);
    expect(
      plan.gaps.some((g) => g.reason.includes("no supported correlation key")),
    ).toBe(true);
  });
});

describe("window → object-key mapping", () => {
  it("derives a single UTC day partition for an intraday window", () => {
    const { dates, truncated } = cloudflareDatePartitions(WINDOW);
    expect(dates).toEqual(["20260708"]);
    expect(truncated).toBe(false);
  });

  it("caps + flags a window spanning more than MAX_DATE_PARTITIONS days", () => {
    const wide = {
      start: Date.parse("2026-07-01T00:00:00.000Z"),
      end: Date.parse("2026-07-08T23:59:59.000Z"),
    };
    const { dates, truncated } = cloudflareDatePartitions(wide);
    expect(dates).toHaveLength(MAX_DATE_PARTITIONS);
    expect(dates[0]).toBe("20260708"); // newest-first
    expect(truncated).toBe(true);
  });

  it("normalizes prefixes", () => {
    expect(normalizeCloudflarePrefix(undefined)).toBe("");
    expect(normalizeCloudflarePrefix("")).toBe("");
    expect(normalizeCloudflarePrefix("/cf-logs/")).toBe("cf-logs/");
    expect(normalizeCloudflarePrefix("a/b")).toBe("a/b/");
  });

  it("parses the batch time range embedded in a Logpush key", () => {
    const kw = parseKeyWindow(
      "cf-logs/20260708/20260708T123000Z_20260708T124500Z_a1b2c3.log.gz",
    );
    expect(kw).toEqual({
      start: Date.parse("2026-07-08T12:30:00Z"),
      end: Date.parse("2026-07-08T12:45:00Z"),
    });
  });

  it("returns undefined for a key with no parseable range", () => {
    expect(parseKeyWindow("cf-logs/20260708/manifest.json")).toBeUndefined();
  });
});

describe("ListObjectsV2 XML + NDJSON decoding", () => {
  it("parses object keys, sizes, and the truncation flag", () => {
    const parsed = parseListObjectsV2(LIST_HTTP_XML);
    expect(parsed.truncated).toBe(false);
    expect(parsed.objects).toHaveLength(2);
    expect(parsed.objects[0].key).toBe(
      "cf-logs/20260708/20260708T123000Z_20260708T124500Z_a1b2c3.log.gz",
    );
    expect(parsed.objects[0].size).toBe(512);
  });

  it("gunzips a gzipped object body and parses NDJSON lines", () => {
    const gz = gzipSync(Buffer.from(HTTP_NDJSON, "utf8"));
    const lines = parseNdjsonLines(decodeNdjson(gz));
    expect(lines).toHaveLength(2);
    expect(lines[0].RayID).toBe("8a1b2c3d4e5f6789");
  });

  it("reads a plain (non-gzipped) NDJSON body", () => {
    const lines = parseNdjsonLines(decodeNdjson(Buffer.from(WORKERS_NDJSON)));
    expect(lines).toHaveLength(2);
    expect(lines[0].Outcome).toBe("exception");
  });

  it("skips blank / malformed NDJSON lines without throwing", () => {
    const lines = parseNdjsonLines('{"a":1}\n\nnot json\n{"b":2}\n');
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("normalizes Logpush timestamps (rfc3339 / unix s / ms / nanos)", () => {
    const ms = Date.parse("2026-07-08T12:34:56.789Z");
    expect(cloudflareToMs("2026-07-08T12:34:56.789Z")).toBe(ms);
    expect(cloudflareToMs(1783514096)).toBe(1783514096000); // seconds
    expect(cloudflareToMs(1783514096789)).toBe(1783514096789); // ms
    expect(cloudflareToMs(1783514096789000000)).toBe(1783514096789); // nanos
  });
});

describe("normalize* — the template shapes", () => {
  it("maps an http_requests line to lane network / cloudflare.http", () => {
    const line = parseNdjsonLines(HTTP_NDJSON)[0];
    const { item } = normalizeHttpRequestLine(line);
    expect(item).toMatchObject({
      lane: "network",
      kind: "cloudflare.http",
      before: null,
      ref: { provider: "cloudflare", id: "8a1b2c3d4e5f6789" },
      whenObserved: Date.parse("2026-07-08T12:34:56.789Z"),
    });
    expect(item.id).toBe("cloudflare:http:8a1b2c3d4e5f6789");
    expect(item.brief).toContain("POST /api/checkout");
    expect(item.brief).toContain("500");
    expect(item.ref.url).toBe(
      "https://acme.example.com/api/checkout?token=abcdef0123456789abcdef0123",
    );
  });

  it("maps a Workers Trace Event to lane logs / cloudflare.worker", () => {
    const line = parseNdjsonLines(WORKERS_NDJSON)[0];
    const { item } = normalizeWorkerTraceLine(line);
    expect(item).toMatchObject({
      lane: "logs",
      kind: "cloudflare.worker",
      before: null,
      ref: { provider: "cloudflare", id: "aa11bb22cc33dd44" },
      whenObserved: 1783514096789,
    });
    expect(item.id).toBe("cloudflare:worker:aa11bb22cc33dd44");
    expect(item.brief).toContain("exception");
    expect(item.brief).toContain("checkout-worker");
    // `after` prefers the actual logs/exceptions the event carried.
    expect(String(item.after)).toContain("Exceptions");
  });
});

describe("CloudflareEvidenceSource.fetchEvidence — http_requests end to end", () => {
  it("lists + reads only in-window objects and normalizes network items", async () => {
    const { source, requests } = makeSource({ dataset: "http_requests" });
    const result = await source.fetchEvidence(query());

    // Both http lines fall inside the window → 2 network items.
    expect(
      result.items.filter((i) => i.kind === "cloudflare.http"),
    ).toHaveLength(2);
    expect(result.stats).toMatchObject({ provider: "cloudflare", returned: 2 });

    // Object-level time mapping: the 12:30 batch was read, the 20:00 batch (out
    // of the 12:00–13:00 window) was NOT — no unbounded reads.
    const gets = requests.filter((r) => !r.url.includes("list-type=2"));
    expect(gets.some((r) => r.url.includes("20260708T123000Z"))).toBe(true);
    expect(gets.some((r) => r.url.includes("20260708T200000Z"))).toBe(false);
  });

  it("signs every request with SigV4 (service s3 / region auto) + UA + content hash", async () => {
    const { source, requests } = makeSource({ dataset: "http_requests" });
    await source.fetchEvidence(query());
    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers["Authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(req.headers["Authorization"]).toContain("/auto/s3/aws4_request");
      expect(req.headers["Authorization"]).toContain(ACCESS_KEY);
      expect(req.headers["x-amz-content-sha256"]).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      // The secret NEVER travels on the wire.
      expect(JSON.stringify(req.headers)).not.toContain(SECRET);
    }
  });

  it("applies the line-level requestId filter", async () => {
    const { source } = makeSource({ dataset: "http_requests" });
    const result = await source.fetchEvidence(
      query({ keys: { requestId: "9b2c3d4e5f6a7890" } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].ref.id).toBe("9b2c3d4e5f6a7890");
  });

  it("applies the line-level url filter", async () => {
    const { source } = makeSource({ dataset: "http_requests" });
    const result = await source.fetchEvidence(
      query({ keys: { url: "/api/status" } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].brief).toContain("/api/status");
  });

  it("respects maxItems (truncates, no walk beyond it)", async () => {
    const { source } = makeSource({ dataset: "http_requests" });
    const result = await source.fetchEvidence(
      query({ limits: { ...LIMITS, maxItems: 1 } }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.stats.truncated).toBe(true);
    expect(result.stats.fetched).toBe(2);
  });

  it("emits a truncation gap + stats.truncated when a partition's listing is truncated (>1000 objects)", async () => {
    const { source } = makeSource({
      dataset: "http_requests",
      truncatedList: true,
    });
    const result = await source.fetchEvidence(query());
    // The single 1000-key page is not walked; the dropped newest objects are an
    // honest gap, not silent data loss.
    expect(result.stats.truncated).toBe(true);
    expect(
      result.gaps.some(
        (g) =>
          g.reason.includes(
            "more than 1000 Logpush objects in partition 20260708",
          ) &&
          g.reason.includes("only the first page was listed") &&
          g.reason.includes("newest objects may be missing"),
      ),
    ).toBe(true);
  });

  it("respects maxBytes (byte-cap truncation)", async () => {
    const { source } = makeSource({ dataset: "http_requests" });
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
});

describe("CloudflareEvidenceSource.fetchEvidence — workers_trace_events", () => {
  it("reads plain NDJSON and normalizes log items", async () => {
    const { source } = makeSource({ dataset: "workers_trace_events" });
    const result = await source.fetchEvidence(query());
    expect(
      result.items.filter((i) => i.kind === "cloudflare.worker"),
    ).toHaveLength(2);
    expect(result.items.every((i) => i.lane === "logs")).toBe(true);
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("strips the query-token from the http ref.url and never leaks it in after", async () => {
    const { source } = makeSource({ dataset: "http_requests" });
    const out = await fetchAdapterEvidence([source], query());
    const item = out.items.find((i) => i.ref.id === "8a1b2c3d4e5f6789")!;
    // redactUrl scrubs the embedded query secret from the deep link.
    expect(item.ref.url).not.toContain("abcdef0123456789");
    // The query is dropped from the free-text `after` at the source, so the
    // secret cannot leak through a field the generic boundary can't parse.
    expect(String(item.after)).not.toContain("abcdef0123456789abcdef0123");
  });

  it("redacts a Bearer token carried in a Workers exception payload", async () => {
    const { source } = makeSource({ dataset: "workers_trace_events" });
    const out = await fetchAdapterEvidence([source], query());
    const item = out.items.find((i) => i.ref.id === "aa11bb22cc33dd44")!;
    expect(String(item.after)).not.toContain("abcdef0123456789abcdef0123");
    expect(String(item.after)).toContain("[REDACTED]");
  });
});

describe("CloudflareEvidenceSource — resilience + hard failure", () => {
  it("keeps the fast object's items when another object out-runs the read budget (partial → ok)", async () => {
    // Full-day window overlaps both objects; the 20:00 GetObject hangs.
    const { source } = makeSource({
      dataset: "http_requests",
      slowKey: "20260708T200000Z",
    });
    const out = await fetchAdapterEvidence([source], {
      window: FULL_DAY,
      keys: {},
      limits: { ...LIMITS, timeoutMs: 400 },
    });
    expect(
      out.items.filter((i) => i.kind === "cloudflare.http").length,
    ).toBeGreaterThanOrEqual(2);
    expect(out.gaps.some((g) => g.reason.includes("did not complete"))).toBe(
      true,
    );
    const stat = out.stats.find((s) => s.provider === "cloudflare");
    expect(stat?.ok).toBe(true);
  });

  it("degrades a total list failure to a source-unavailable gap → ok:false (no secret leak)", async () => {
    const { source } = makeSource({ dataset: "http_requests", failList: true });
    const out = await fetchAdapterEvidence([source], query());
    expect(out.items).toHaveLength(0);
    const stat = out.stats.find((s) => s.provider === "cloudflare");
    expect(stat?.ok).toBe(false);
    expect(
      out.gaps.some(
        (g) =>
          g.reason.includes("cloudflare") && g.kind === "source-unavailable",
      ),
    ).toBe(true);
    expect(stat?.error ?? "").not.toContain(SECRET);
  });

  it("degrades a total read failure to a source-unavailable gap → ok:false", async () => {
    const { source } = makeSource({
      dataset: "http_requests",
      failReads: true,
    });
    const out = await fetchAdapterEvidence([source], query());
    expect(out.items).toHaveLength(0);
    const stat = out.stats.find((s) => s.provider === "cloudflare");
    expect(stat?.ok).toBe(false);
    expect(
      out.gaps.some(
        (g) =>
          g.reason.includes("read failed") && g.kind === "source-unavailable",
      ),
    ).toBe(true);
  });
});

describe("CloudflareEvidenceSource — health()", () => {
  it("reports ok on a 200 ListObjectsV2", async () => {
    const { source, requests } = makeSource({ dataset: "http_requests" });
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "cloudflare" });
    expect(requests[0].url).toContain("list-type=2");
    expect(requests[0].url).toContain("max-keys=1");
  });

  it("reports a sanitized error on failure (no secret in the message)", async () => {
    const { source } = makeSource({ dataset: "http_requests", failList: true });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("403");
    expect(health.error).not.toContain(SECRET);
  });
});

describe("registry wiring", () => {
  it("declares the Cloudflare descriptor", () => {
    expect(CLOUDFLARE_DESCRIPTOR).toMatchObject({
      provider: "cloudflare",
      displayName: "Cloudflare",
      lanes: ["network", "logs"],
      joinKeys: ["requestId", "url", "time"],
    });
  });

  it("evidenceSourcesFromEnv returns a Cloudflare source when its env vars are set", () => {
    registerEvidenceProvider(cloudflareEvidenceProvider); // idempotent
    const env = {
      [CLOUDFLARE_R2_ACCOUNT_ID_ENV]: "acct123",
      [CLOUDFLARE_R2_ACCESS_KEY_ID_ENV]: "ak",
      [CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV]: "sk",
      [CLOUDFLARE_R2_BUCKET_ENV]: "cf-logs-bucket",
      [CLOUDFLARE_R2_PREFIX_ENV]: "cf-logs",
      [CLOUDFLARE_R2_DATASET_ENV]: "workers_trace_events",
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("cloudflare");
  });

  it("omits Cloudflare when a required var (bucket) is missing", () => {
    const sources = evidenceSourcesFromEnv({
      [CLOUDFLARE_R2_ACCOUNT_ID_ENV]: "acct123",
      [CLOUDFLARE_R2_ACCESS_KEY_ID_ENV]: "ak",
      [CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV]: "sk",
    });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain(
      "cloudflare",
    );
  });
});
