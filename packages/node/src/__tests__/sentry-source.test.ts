import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  SentryEvidenceSource,
  buildSentryQuery,
  normalizeSentryIssue,
  sentryEvidenceProvider,
  SENTRY_AUTH_TOKEN_ENV,
  SENTRY_ORG_ENV,
  SENTRY_HOST_ENV,
  SENTRY_DESCRIPTOR,
} from "../evidence-sources/sentry";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import issuesList from "./fixtures/evidence-sources/sentry/issues-list.json";
import eventOne from "./fixtures/evidence-sources/sentry/event-latest-1234567890.json";
import eventTwo from "./fixtures/evidence-sources/sentry/event-latest-9876543210.json";

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
  headers: Record<string, string>;
}

/**
 * A fixture-replaying transport. NO network: it routes by URL to the recorded
 * Sentry response samples and records every request (to assert UA + Bearer auth).
 * This is the seam CP4–CP7 mirror: inject `fetchImpl` and replay fixtures.
 */
function fakeSentry(
  options: { org?: string; failEvents?: boolean; hangEvents?: boolean } = {},
) {
  const org = options.org ?? "acme";
  const requests: RecordedRequest[] = [];
  const eventsById: Record<string, unknown> = {
    "1234567890": eventOne,
    "9876543210": eventTwo,
  };

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const json = async (data: unknown) => data;
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: () => json(data),
    });

    // Health / org endpoint.
    if (url.endsWith(`/organizations/${org}/`)) return ok({ slug: org });

    // Latest event for an issue.
    const eventMatch = url.match(/\/issues\/(\d+)\/events\/latest\/$/);
    if (eventMatch) {
      if (options.failEvents)
        return { ok: false, status: 500, json: () => json({}) };
      if (options.hangEvents) {
        // Never resolve on its own — only settle (reject) when the enrichment
        // sub-budget/abort fires. This simulates slow stack-head enrichment.
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("Aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
      }
      return ok(eventsById[eventMatch[1]] ?? {});
    }

    // Issues list.
    if (url.includes(`/organizations/${org}/issues/`)) return ok(issuesList);

    return { ok: false, status: 404, json: () => json({}) };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(
  opts: { org?: string; failEvents?: boolean; hangEvents?: boolean } = {},
) {
  const fake = fakeSentry(opts);
  const source = new SentryEvidenceSource({
    authToken: "secret-token-value",
    org: opts.org ?? "acme",
    host: "https://acme.sentry.io",
    fetchImpl: fake.fetchImpl,
  });
  return { source, requests: fake.requests };
}

describe("buildSentryQuery — descriptor-keyed construction", () => {
  it("uses a single trace token when a trace id is present (tightest filter)", () => {
    const plan = buildSentryQuery(
      query({ keys: { traceId: "abc123", url: "/x" } }),
    );
    expect(plan.search).toBe("trace:abc123");
    expect(plan.usedKeys).toEqual(["traceId"]);
    expect(plan.gaps).toEqual([]);
  });

  it("combines url/release/user tokens when no trace is present", () => {
    const plan = buildSentryQuery(
      query({
        keys: { url: "/checkout", release: "web@1.2.3", user: "a@b.com" },
      }),
    );
    expect(plan.search).toBe(
      "url:/checkout release:web@1.2.3 user.email:a@b.com",
    );
    expect(plan.usedKeys).toEqual(["url", "release", "user"]);
    expect(plan.gaps).toEqual([]);
  });

  it("quotes values containing whitespace or colons", () => {
    const plan = buildSentryQuery(query({ keys: { url: "/a b" } }));
    expect(plan.search).toBe('url:"/a b"');
  });

  it("escapes embedded quotes/backslashes so a value cannot break out of its token", () => {
    const plan = buildSentryQuery(query({ keys: { url: '/a "b" c' } }));
    // The embedded quotes are backslash-escaped inside a quoted token.
    expect(plan.search).toBe('url:"/a \\"b\\" c"');

    const backslash = buildSentryQuery(query({ keys: { release: "web\\1" } }));
    expect(backslash.search).toBe('release:"web\\\\1"');
  });

  it("emits a time-only gap when no supported key is present", () => {
    const plan = buildSentryQuery(query({ keys: {} }));
    expect(plan.search).toBe("");
    expect(plan.usedKeys).toEqual([]);
    expect(plan.gaps).toHaveLength(1);
    expect(plan.gaps[0].reason).toContain(
      "no supported correlation key present",
    );
  });

  it("emits a per-key gap when a requested key is unsupported (requestId)", () => {
    const plan = buildSentryQuery(query({ keys: { requestId: "req-1" } }));
    expect(
      plan.gaps.some(
        (g) =>
          g.reason ===
          "sentry: cannot filter by requestId; used time window only",
      ),
    ).toBe(true);
  });
});

describe("normalizeSentryIssue — the template shape", () => {
  it("maps an issue + latest event to the exact evidence.v1 shape", () => {
    const item = normalizeSentryIssue(issuesList[0], eventOne);
    expect(item).toMatchObject({
      id: "sentry:1234567890",
      lane: "logs",
      kind: "sentry.error",
      ref: {
        provider: "sentry",
        id: "1234567890",
        url: "https://acme.sentry.io/organizations/acme/issues/1234567890/",
      },
      before: null,
      whenObserved: Date.parse("2026-07-08T12:34:56.000Z"),
    });
    // brief = "<title> — <culprit>", short.
    expect(item.brief).toBe(
      "TypeError: Cannot read properties of undefined (reading 'id') — checkout(app/checkout/pay.ts)",
    );
    expect(item.brief.length).toBeLessThanOrEqual(141);
    // after = crash-first trimmed stack head.
    const after = item.after as string;
    expect(after.split("\n")[0]).toContain("TypeError:");
    expect(after).toContain("at readId (app/checkout/pay.ts:17)");
    expect(after.indexOf("readId")).toBeLessThan(
      after.indexOf("handleRequest"),
    );
  });

  it("tolerates a missing event (after = null)", () => {
    const item = normalizeSentryIssue(issuesList[0], undefined);
    expect(item.after).toBeNull();
  });
});

describe("SentryEvidenceSource.fetchEvidence — end to end (fixtures)", () => {
  it("returns normalized items and sends UA + Bearer auth on every request", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { traceId: "t-1" } }),
    );

    expect(result.items.map((i) => i.id)).toEqual([
      "sentry:1234567890",
      "sentry:9876543210",
    ]);
    expect(result.stats).toMatchObject({
      provider: "sentry",
      fetched: 2,
      returned: 2,
    });

    // Query construction reached the wire: issues URL carries the trace token + window.
    const issuesReq = requests.find((r) =>
      /\/issues\/$/.test(new URL(r.url).pathname),
    );
    const parsed = new URL(issuesReq!.url);
    expect(parsed.searchParams.get("query")).toBe("trace:t-1");
    expect(parsed.searchParams.get("start")).toBe(
      new Date(WINDOW.start).toISOString(),
    );
    expect(parsed.searchParams.get("end")).toBe(
      new Date(WINDOW.end).toISOString(),
    );

    // Egress identity on every outbound call.
    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers.Authorization).toBe("Bearer secret-token-value");
    }
  });

  it("still emits items when event enrichment fails (after = null, no throw)", async () => {
    const { source } = makeSource({ failEvents: true });
    const result = await source.fetchEvidence(query());
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.after === null)).toBe(true);
  });

  it("returns issues-list items when the signal is already aborted (after = null, not empty)", async () => {
    const { source, requests } = makeSource({ hangEvents: true });
    const controller = new AbortController();
    controller.abort();
    // Large window; primary issues query still succeeds (the fixture transport
    // does not gate the list call), but enrichment must be skipped entirely.
    const result = await source.fetchEvidence(
      query({ limits: { ...LIMITS, maxItems: 50 } }),
      controller.signal,
    );
    // Primary evidence survives the aborted enrichment.
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.after === null)).toBe(true);
    expect(result.stats.returned).toBe(2);
    // No /events/latest/ call was even attempted (enrichment short-circuited).
    expect(
      requests.some((r) => /\/events\/latest\/$/.test(new URL(r.url).pathname)),
    ).toBe(false);
    // Honest gap about incomplete enrichment, never an empty timeout result.
    expect(
      result.gaps.some((g) => g.reason.includes("enrichment did not complete")),
    ).toBe(true);
  });

  it("returns issues-list items when enrichment is slower than its sub-budget (not empty)", async () => {
    const { source } = makeSource({ hangEvents: true });
    // Tiny per-source budget → tiny enrichment sub-budget → events never finish.
    const result = await source.fetchEvidence(
      query({ limits: { ...LIMITS, maxItems: 50, timeoutMs: 40 } }),
    );
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.after === null)).toBe(true);
    expect(
      result.gaps.some((g) => g.reason.includes("enrichment did not complete")),
    ).toBe(true);
  });

  it("preserves primary items through fetchAdapterEvidence when enrichment out-runs the timeout", async () => {
    const { source } = makeSource({ hangEvents: true });
    // Framework per-source timeout = query.limits.timeoutMs (80ms). The adapter's
    // enrichment sub-budget (~40ms) fires first, so it resolves with primary
    // items BEFORE the framework's timeout can discard the whole result.
    const out = await fetchAdapterEvidence(
      [source],
      query({ limits: { ...LIMITS, maxItems: 50, timeoutMs: 80 } }),
    );
    expect(out.items).toHaveLength(2);
    expect(out.items.every((i) => i.after === null)).toBe(true);
    // The source is reported as a successful (ok) partial fetch, not a timeout.
    const stat = out.stats.find((s) => s.provider === "sentry");
    expect(stat?.ok).toBe(true);
    expect(stat?.returned).toBe(2);
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
  });

  it("respects maxBytes (byte-cap truncation)", async () => {
    const { source } = makeSource();
    // Admit the first item, refuse the second on the byte budget.
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

describe("SentryEvidenceSource — health()", () => {
  it("reports ok on a 200 from the org endpoint", async () => {
    const { source, requests } = makeSource();
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "sentry" });
    expect(requests[0].url).toContain("/organizations/acme/");
  });

  it("reports a sanitized error on failure (no token in message)", async () => {
    const source = new SentryEvidenceSource({
      authToken: "secret-token-value",
      org: "acme",
      host: "https://acme.sentry.io",
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("401");
    expect(health.error).not.toContain("secret-token-value");
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("scrubs a token in the stack head and strips a token from the ref URL", async () => {
    const { source } = makeSource();
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { traceId: "t-1" } }),
    );

    const first = out.items.find((i) => i.id === "sentry:1234567890")!;
    // Token embedded in the exception value must not survive into the bundle.
    expect(String(first.after)).not.toContain("abcdef0123456789");
    expect(String(first.after)).toContain("[REDACTED]");

    // Plain issue URL is preserved as provenance...
    expect(first.ref.url).toBe(
      "https://acme.sentry.io/organizations/acme/issues/1234567890/",
    );
    // ...but a token in the query of the second issue's permalink is stripped.
    const second = out.items.find((i) => i.id === "sentry:9876543210")!;
    expect(second.ref.url).not.toContain("abcdef0123456789");
    expect(second.ref.url).toContain("/issues/9876543210/");
  });
});

describe("registry wiring", () => {
  it("declares the reference descriptor", () => {
    expect(SENTRY_DESCRIPTOR).toMatchObject({
      provider: "sentry",
      displayName: "Sentry",
      lanes: ["logs", "code"],
      joinKeys: ["traceId", "time", "release", "url", "user"],
    });
  });

  it("evidenceSourcesFromEnv returns a Sentry source when its env vars are set", () => {
    // The barrel import above registered the provider; assert it is picked up.
    registerEvidenceProvider(sentryEvidenceProvider); // idempotent
    const env = {
      [SENTRY_AUTH_TOKEN_ENV]: "tok",
      [SENTRY_ORG_ENV]: "acme",
      [SENTRY_HOST_ENV]: "https://acme.sentry.io",
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("sentry");
  });

  it("omits Sentry when the token is missing", () => {
    const sources = evidenceSourcesFromEnv({ [SENTRY_ORG_ENV]: "acme" });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain("sentry");
  });
});
