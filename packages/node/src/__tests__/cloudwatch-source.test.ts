import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  CloudWatchEvidenceSource,
  buildCloudWatchQuery,
  cloudWatchDeepLink,
  cloudWatchEvidenceProvider,
  normalizeCloudWatchRow,
  CLOUDWATCH_ACCESS_KEY_ID_ENV,
  CLOUDWATCH_SECRET_ACCESS_KEY_ENV,
  CLOUDWATCH_REGION_ENV,
  CLOUDWATCH_LOG_GROUPS_ENV,
  CLOUDWATCH_DESCRIPTOR,
  type CloudWatchResultRow,
} from "../evidence-sources/cloudwatch";
import { signSigV4 } from "../evidence-sources/sigv4";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import startQuery from "./fixtures/evidence-sources/cloudwatch/start-query.json";
import resultsComplete from "./fixtures/evidence-sources/cloudwatch/get-query-results-complete.json";
import resultsRunning from "./fixtures/evidence-sources/cloudwatch/get-query-results-running.json";

const WINDOW = {
  start: Date.parse("2026-07-08T00:00:00.000Z"),
  end: Date.parse("2026-07-08T23:59:59.000Z"),
};
const LIMITS = { maxItems: 50, maxBytes: 1_000_000, timeoutMs: 10_000 };
const REGION = "us-east-1";
const GROUP = "/aws/lambda/checkout";

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  target: string;
  body: Record<string, unknown>;
}

/**
 * A fixture-replaying transport routed by the `X-Amz-Target` header. NO network:
 * it returns the recorded StartQuery / GetQueryResults samples and records every
 * request (to assert the SigV4 Authorization + UA + query body reached the wire).
 * The seam CP4 mirrors from the Sentry reference: inject `fetchImpl`, replay JSON.
 */
function fakeCloudWatch(
  options: {
    /** GetQueryResults status source: "complete" (default) or "running" forever. */
    mode?: "complete" | "running";
    /** Log groups whose StartQuery returns HTTP 400 (bad group). */
    failGroups?: string[];
  } = {},
) {
  const mode = options.mode ?? "complete";
  const failGroups = new Set(options.failGroups ?? []);
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    const target = headers["X-Amz-Target"] ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, headers, target, body });

    const json = async (data: unknown) => data;
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: () => json(data),
    });

    if (target.endsWith(".DescribeLogGroups")) return ok({ logGroups: [] });

    if (target.endsWith(".StartQuery")) {
      const group = (body.logGroupNames as string[] | undefined)?.[0];
      if (group && failGroups.has(group)) {
        return {
          ok: false,
          status: 400,
          json: () => json({ __type: "ResourceNotFoundException" }),
        };
      }
      return ok(startQuery);
    }

    if (target.endsWith(".GetQueryResults")) {
      return ok(mode === "running" ? resultsRunning : resultsComplete);
    }

    return { ok: false, status: 404, json: () => json({}) };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(
  opts: {
    mode?: "complete" | "running";
    failGroups?: string[];
    logGroups?: string[];
    pollIntervalMs?: number;
  } = {},
) {
  const fake = fakeCloudWatch(opts);
  const source = new CloudWatchEvidenceSource({
    accessKeyId: "AKIA-TEST-KEY-ID",
    secretAccessKey: "super-secret-signing-key",
    region: REGION,
    logGroups: opts.logGroups ?? [GROUP],
    endpoint: `https://logs.${REGION}.amazonaws.com`,
    fetchImpl: fake.fetchImpl,
    pollIntervalMs: opts.pollIntervalMs ?? 2,
  });
  return { source, requests: fake.requests };
}

describe("buildCloudWatchQuery — descriptor-keyed construction", () => {
  it("uses a requestId message filter (best-first over traceId)", () => {
    const plan = buildCloudWatchQuery(
      query({ keys: { requestId: "req_abc123", traceId: "t-1" } }),
    );
    expect(plan.usedKeys).toEqual(["requestId"]);
    expect(plan.queryString).toContain('filter @message like "req_abc123"');
    expect(plan.gaps).toEqual([]);
  });

  it("falls back to a traceId message filter when no requestId is present", () => {
    const plan = buildCloudWatchQuery(
      query({ keys: { traceId: "trace-xyz" } }),
    );
    expect(plan.usedKeys).toEqual(["traceId"]);
    expect(plan.queryString).toContain('filter @message like "trace-xyz"');
  });

  it("escapes embedded quotes/backslashes so a value cannot break out of the token", () => {
    const plan = buildCloudWatchQuery(query({ keys: { requestId: 'a"b\\c' } }));
    expect(plan.queryString).toContain('filter @message like "a\\"b\\\\c"');
  });

  it("emits a time-only gap and no filter when no supported key is present", () => {
    const plan = buildCloudWatchQuery(query({ keys: {} }));
    expect(plan.usedKeys).toEqual([]);
    expect(plan.queryString).not.toContain("filter");
    expect(
      plan.gaps.some((g) => g.reason.includes("no supported correlation key")),
    ).toBe(true);
  });

  it("emits a per-key gap when a requested key is unsupported (sessionId)", () => {
    const plan = buildCloudWatchQuery(query({ keys: { sessionId: "s-1" } }));
    expect(
      plan.gaps.some(
        (g) =>
          g.reason ===
          "cloudwatch: cannot filter by sessionId; used time window only",
      ),
    ).toBe(true);
  });

  it("emits an honest gap for `service` (scoped by log groups, not a message filter)", () => {
    const plan = buildCloudWatchQuery(query({ keys: { service: "checkout" } }));
    // service is a declared join key, so it is NOT reported as unsupported...
    expect(
      plan.gaps.some((g) => g.reason.includes("cannot filter by service")),
    ).toBe(false);
    // ...but it does not become a query filter either — an honest gap explains
    // it is scoped via the configured log group(s), never a silent no-op.
    expect(
      plan.gaps.some((g) =>
        g.reason.includes("service is scoped by the configured log group"),
      ),
    ).toBe(true);
    expect(plan.usedKeys).toEqual([]);
    expect(plan.queryString).not.toContain("filter");
  });

  it("bounds the scan to maxItems via a hard limit clause", () => {
    const plan = buildCloudWatchQuery(
      query({ limits: { ...LIMITS, maxItems: 7 } }),
    );
    expect(plan.queryString).toContain("limit 7");
    expect(plan.queryString).toContain("sort @timestamp desc");
  });
});

describe("normalizeCloudWatchRow — the template shape", () => {
  const row = resultsComplete.results[0] as CloudWatchResultRow;

  it("maps a Logs Insights row to the exact evidence.v1 shape", () => {
    const item = normalizeCloudWatchRow(row, REGION, GROUP);
    expect(item).toMatchObject({
      lane: "logs",
      kind: "cloudwatch.log",
      before: null,
      ref: { provider: "cloudwatch" },
      whenObserved: Date.parse("2026-07-08T12:34:56.789Z"),
    });
    expect(item.id.startsWith("cloudwatch:")).toBe(true);
    expect(item.ref.url).toBe(cloudWatchDeepLink(REGION, GROUP));
    expect(item.brief.length).toBeLessThanOrEqual(141);
    expect(String(item.after)).toContain("checkout failed");
  });

  it("builds a console deep link that double-encodes the log group path", () => {
    expect(cloudWatchDeepLink(REGION, GROUP)).toBe(
      "https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1" +
        "#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fcheckout",
    );
  });
});

describe("CloudWatchEvidenceSource.fetchEvidence — end to end (fixtures)", () => {
  it("returns normalized items and signs + UAs every request; StartQuery carries the plan", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { requestId: "req_abc123" } }),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.kind === "cloudwatch.log")).toBe(true);
    expect(result.stats).toMatchObject({
      provider: "cloudwatch",
      fetched: 2,
      returned: 2,
    });

    // StartQuery body reached the wire with the window (in seconds) + filter + limit.
    const start = requests.find((r) => r.target.endsWith(".StartQuery"))!;
    expect(start.body.logGroupNames).toEqual([GROUP]);
    expect(start.body.startTime).toBe(Math.floor(WINDOW.start / 1000));
    expect(start.body.endTime).toBe(Math.floor(WINDOW.end / 1000));
    expect(String(start.body.queryString)).toContain(
      'filter @message like "req_abc123"',
    );

    // Egress identity + SigV4 auth on every outbound call; secret never on the wire.
    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIA-TEST-KEY-ID\//,
      );
      expect(JSON.stringify(req.headers)).not.toContain(
        "super-secret-signing-key",
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
    // fetched still counts every row seen; returned is the capped count.
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

  it("degrades a failed log group to a gap while other groups still return", async () => {
    const groups = [GROUP, "/aws/lambda/bad"];
    const { source } = makeSource({
      logGroups: groups,
      failGroups: ["/aws/lambda/bad"],
    });
    const result = await source.fetchEvidence(
      query({ keys: { requestId: "req_abc123" } }),
    );
    // Good group's rows survive.
    expect(result.items.length).toBeGreaterThan(0);
    // Bad group surfaces an honest, scoped gap — not a thrown error.
    expect(
      result.gaps.some((g) =>
        g.reason.includes("cloudwatch[/aws/lambda/bad]: fetch failed"),
      ),
    ).toBe(true);
  });

  it("stays ok:true through the framework when one group fails but another returns rows (partial success)", async () => {
    const groups = [GROUP, "/aws/lambda/bad"];
    const { source } = makeSource({
      logGroups: groups,
      failGroups: ["/aws/lambda/bad"],
    });
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { requestId: "req_abc123" } }),
    );
    expect(out.items.length).toBeGreaterThan(0);
    const stat = out.stats.find((s) => s.provider === "cloudwatch");
    // Partial success keeps ok:true; the failed group's gap is NOT a hard-failure marker.
    expect(stat?.ok).toBe(true);
    expect(out.gaps.some((g) => g.kind === "source-unavailable")).toBe(false);
  });

  it("reports ok:false through the framework when ALL groups fail (zero items)", async () => {
    const groups = [GROUP, "/aws/lambda/bad"];
    const { source } = makeSource({ logGroups: groups, failGroups: groups });
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { requestId: "req_abc123" } }),
    );
    expect(out.items).toHaveLength(0);
    const stat = out.stats.find((s) => s.provider === "cloudwatch");
    // Total failure (no group delivered anything) → ok:false, parity with a throw.
    expect(stat?.ok).toBe(false);
    expect(
      out.gaps.some(
        (g) =>
          g.reason.includes("cloudwatch[") && g.kind === "source-unavailable",
      ),
    ).toBe(true);
  });
});

describe("CloudWatchEvidenceSource — resilience / self-limiting poll budget", () => {
  it("returns the completed snapshot (not empty) when the query out-runs its budget", async () => {
    const { source } = makeSource({ mode: "running", pollIntervalMs: 2 });
    // Tiny per-source budget → tiny poll deadline → query never reaches Complete.
    const result = await source.fetchEvidence(
      query({
        keys: { requestId: "req_abc123" },
        limits: { ...LIMITS, timeoutMs: 40 },
      }),
    );
    // The partial `results` snapshot still yields evidence — never zero items.
    expect(result.items).toHaveLength(1);
    expect(
      result.gaps.some((g) => g.reason.includes("did not complete within")),
    ).toBe(true);
  });

  it("preserves partial items through fetchAdapterEvidence when polling out-runs the framework timeout", async () => {
    const { source } = makeSource({ mode: "running", pollIntervalMs: 2 });
    // Framework per-source timeout = query.limits.timeoutMs (80ms). The adapter's
    // poll sub-budget (~64ms) fires first, so it resolves with the partial snapshot
    // BEFORE the framework's timeout can discard the whole result.
    const out = await fetchAdapterEvidence(
      [source],
      query({
        keys: { requestId: "req_abc123" },
        limits: { ...LIMITS, timeoutMs: 80 },
      }),
    );
    expect(out.items).toHaveLength(1);
    const stat = out.stats.find((s) => s.provider === "cloudwatch");
    expect(stat?.ok).toBe(true);
    expect(stat?.returned).toBe(1);
  });
});

describe("CloudWatchEvidenceSource — health()", () => {
  it("reports ok on a 200 from DescribeLogGroups", async () => {
    const { source, requests } = makeSource();
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "cloudwatch" });
    expect(requests[0].target.endsWith(".DescribeLogGroups")).toBe(true);
  });

  it("reports a sanitized error on failure (no secret in the message)", async () => {
    const source = new CloudWatchEvidenceSource({
      accessKeyId: "AKIA-TEST-KEY-ID",
      secretAccessKey: "super-secret-signing-key",
      region: REGION,
      logGroups: [GROUP],
      fetchImpl: (async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("403");
    expect(health.error).not.toContain("super-secret-signing-key");
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("scrubs a token embedded in a log line's message body", async () => {
    const { source } = makeSource();
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { requestId: "req_abc123" } }),
    );
    const first = out.items[0];
    // The Bearer token in @message must not survive into the bundle.
    expect(String(first.after)).not.toContain("abcdef0123456789");
    expect(String(first.after)).toContain("[REDACTED]");
    // The plain console deep link is preserved as provenance.
    expect(first.ref.url).toContain("console.aws.amazon.com");
  });
});

describe("SigV4 signing — correctness against the AWS test-suite vector", () => {
  it("reproduces the canonical `get-vanilla` signature", () => {
    // AWS SigV4 test suite "get-vanilla": GET https://example.amazonaws.com/,
    // region us-east-1, service "service", AKIDEXAMPLE / wJalrX… at 20150830T123600Z.
    const headers = signSigV4({
      method: "GET",
      url: "https://example.amazonaws.com",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      body: "",
      headers: {},
      now: new Date("2015-08-30T12:36:00.000Z"),
    });
    expect(headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(headers["X-Amz-Date"]).toBe("20150830T123600Z");
  });

  it("signs in the session token when present (temporary/role creds)", () => {
    const headers = signSigV4({
      method: "POST",
      url: "https://logs.us-east-1.amazonaws.com/",
      region: "us-east-1",
      service: "logs",
      accessKeyId: "AKIA-X",
      secretAccessKey: "secret",
      sessionToken: "session-token-value",
      body: "{}",
      headers: { "X-Amz-Target": "Logs_20140328.StartQuery" },
    });
    expect(headers["X-Amz-Security-Token"]).toBe("session-token-value");
    expect(headers.Authorization).toContain("x-amz-security-token");
  });
});

describe("registry wiring", () => {
  it("declares the CloudWatch descriptor", () => {
    expect(CLOUDWATCH_DESCRIPTOR).toMatchObject({
      provider: "cloudwatch",
      displayName: "CloudWatch",
      lanes: ["logs"],
      joinKeys: ["requestId", "traceId", "time", "service"],
    });
  });

  it("evidenceSourcesFromEnv returns a CloudWatch source when its env vars are set", () => {
    registerEvidenceProvider(cloudWatchEvidenceProvider); // idempotent
    const env = {
      [CLOUDWATCH_ACCESS_KEY_ID_ENV]: "AKIA",
      [CLOUDWATCH_SECRET_ACCESS_KEY_ENV]: "secret",
      [CLOUDWATCH_REGION_ENV]: REGION,
      [CLOUDWATCH_LOG_GROUPS_ENV]: `${GROUP},/aws/lambda/other`,
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("cloudwatch");
  });

  it("omits CloudWatch when a required var (log groups) is missing", () => {
    const sources = evidenceSourcesFromEnv({
      [CLOUDWATCH_ACCESS_KEY_ID_ENV]: "AKIA",
      [CLOUDWATCH_SECRET_ACCESS_KEY_ENV]: "secret",
      [CLOUDWATCH_REGION_ENV]: REGION,
    });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain(
      "cloudwatch",
    );
  });
});
