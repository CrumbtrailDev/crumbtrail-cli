import { describe, it, expect } from "vitest";
import type { EvidenceQuery } from "crumbtrail-core";
import {
  PostHogEvidenceSource,
  buildPostHogQuery,
  formatDuration,
  normalizePostHogEvent,
  normalizePostHogRecording,
  posthogEvidenceProvider,
  POSTHOG_API_KEY_ENV,
  POSTHOG_PROJECT_ID_ENV,
  POSTHOG_HOST_ENV,
  POSTHOG_DESCRIPTOR,
  type PostHogEvent,
  type PostHogRecording,
} from "../evidence-sources/posthog";
import {
  evidenceSourcesFromEnv,
  registerEvidenceProvider,
} from "../evidence-sources";
import { fetchAdapterEvidence } from "../evidence-sources/fetch-all";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import eventsQuery from "./fixtures/evidence-sources/posthog/events-query.json";
import recordingsList from "./fixtures/evidence-sources/posthog/recordings-list.json";

const WINDOW = {
  start: Date.parse("2026-07-08T00:00:00.000Z"),
  end: Date.parse("2026-07-08T23:59:59.000Z"),
};
const LIMITS = { maxItems: 50, maxBytes: 1_000_000, timeoutMs: 10_000 };
const PROJECT_ID = "1";

function query(overrides: Partial<EvidenceQuery> = {}): EvidenceQuery {
  return { window: WINDOW, keys: {}, limits: LIMITS, ...overrides };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * A fixture-replaying transport routed by URL path. NO network: it returns the
 * recorded events / recordings samples and records every request (to assert the
 * Bearer key + UA + query params reached the wire). `slowRecordings` makes the
 * recordings endpoint hang until its abort signal fires, so the secondary-budget
 * resilience path can be exercised deterministically. It ALSO 404s any
 * snapshot/content endpoint so a stray content fetch would fail loudly.
 */
function fakePostHog(
  options: { failEvents?: boolean; slowRecordings?: boolean } = {},
) {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    const method = init?.method ?? "GET";
    requests.push({ url, method, headers });

    const json = async (data: unknown) => data;
    const ok = (data: unknown) => ({
      ok: true,
      status: 200,
      json: () => json(data),
    });

    // Recording snapshot/content blobs must never be requested (LINK-ONLY).
    if (
      url.includes("/snapshots") ||
      /\/session_recordings\/[^/?]+\//.test(url)
    ) {
      return { ok: false, status: 404, json: () => json({}) };
    }

    if (url.includes("/session_recordings")) {
      if (options.slowRecordings) {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(abortError());
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
        });
      }
      return ok(recordingsList);
    }

    if (url.includes("/events")) {
      if (options.failEvents)
        return { ok: false, status: 403, json: () => json({}) };
      return ok(eventsQuery);
    }

    // Health check: project endpoint.
    if (/\/api\/projects\/[^/]+\/?(\?|$)/.test(url))
      return ok({ id: 1, name: "proj" });

    return { ok: false, status: 404, json: () => json({}) };
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function makeSource(
  opts: { failEvents?: boolean; slowRecordings?: boolean; host?: string } = {},
) {
  const fake = fakePostHog(opts);
  const source = new PostHogEvidenceSource({
    apiKey: "phx-personal-key-secret",
    projectId: PROJECT_ID,
    host: opts.host,
    fetchImpl: fake.fetchImpl,
  });
  return { source, requests: fake.requests };
}

describe("buildPostHogQuery — descriptor-keyed construction", () => {
  it("applies user as distinct_id (never a no-op)", () => {
    const plan = buildPostHogQuery(query({ keys: { user: "user-42" } }));
    expect(plan.usedKeys).toEqual(["user"]);
    expect(plan.distinctId).toBe("user-42");
    expect(plan.properties).toEqual([]);
    expect(plan.gaps).toEqual([]);
  });

  it("applies sessionId as a $session_id property + recordings session filter", () => {
    const plan = buildPostHogQuery(
      query({ keys: { sessionId: "sess-abc-123" } }),
    );
    expect(plan.usedKeys).toEqual(["sessionId"]);
    expect(plan.sessionId).toBe("sess-abc-123");
    expect(plan.properties).toContainEqual({
      key: "$session_id",
      value: "sess-abc-123",
      operator: "exact",
      type: "event",
    });
  });

  it("applies url as a $current_url property", () => {
    const plan = buildPostHogQuery(
      query({ keys: { url: "https://app.example.com/checkout" } }),
    );
    expect(plan.usedKeys).toEqual(["url"]);
    expect(plan.properties).toContainEqual({
      key: "$current_url",
      value: "https://app.example.com/checkout",
      operator: "exact",
      type: "event",
    });
  });

  it("applies every declared join key together (user + sessionId + url)", () => {
    const plan = buildPostHogQuery(
      query({
        keys: { user: "user-42", sessionId: "sess-1", url: "https://x/pay" },
      }),
    );
    expect(plan.usedKeys).toEqual(["user", "sessionId", "url"]);
    expect(plan.distinctId).toBe("user-42");
    expect(plan.sessionId).toBe("sess-1");
    expect(plan.properties.map((p) => p.key)).toEqual([
      "$session_id",
      "$current_url",
    ]);
    expect(plan.gaps).toEqual([]);
  });

  it("emits a time-only gap when no supported key is present", () => {
    const plan = buildPostHogQuery(query({ keys: {} }));
    expect(plan.usedKeys).toEqual([]);
    expect(plan.distinctId).toBeUndefined();
    expect(plan.properties).toEqual([]);
    expect(
      plan.gaps.some((g) => g.reason.includes("no supported correlation key")),
    ).toBe(true);
  });

  it("emits a per-key gap for each unsupported key (traceId, requestId, release, service)", () => {
    for (const key of ["traceId", "requestId", "release", "service"] as const) {
      const plan = buildPostHogQuery(query({ keys: { [key]: "v" } }));
      expect(
        plan.gaps.some(
          (g) =>
            g.reason ===
            `posthog: cannot filter by ${key}; used time window only`,
        ),
      ).toBe(true);
      // Unsupported key never silently narrows the query.
      expect(plan.usedKeys).toEqual([]);
    }
  });
});

describe("normalize* — the template shapes", () => {
  const appBase = "https://us.posthog.com";

  it("maps a $pageview event to the flow lane with the exact evidence.v1 shape", () => {
    const item = normalizePostHogEvent(
      eventsQuery.results[0] as PostHogEvent,
      appBase,
      PROJECT_ID,
    );
    expect(item).toMatchObject({
      lane: "flow",
      kind: "posthog.event",
      before: null,
      ref: { provider: "posthog", id: "01890abc-EXAMPLE-event-0001" },
      whenObserved: Date.parse("2026-07-08T12:34:56.789Z"),
    });
    expect(item.id).toBe("posthog:event:01890abc-EXAMPLE-event-0001");
    expect(item.brief).toContain("$pageview");
    expect(item.brief).toContain("https://app.example.com/checkout");
    // Person-scoped deep link (distinct id present).
    expect(item.ref.url).toBe(
      "https://us.posthog.com/project/1/person/user-42",
    );
  });

  it("maps a non-pageview event to the browser lane", () => {
    const item = normalizePostHogEvent(
      eventsQuery.results[1] as PostHogEvent,
      appBase,
      PROJECT_ID,
    );
    expect(item.lane).toBe("browser");
    expect((item.after as Record<string, unknown>)["$exception_type"]).toBe(
      "TypeError",
    );
  });

  it("maps a recording to the flow lane, LINK-ONLY (no content in before/after)", () => {
    const item = normalizePostHogRecording(
      recordingsList.results[0] as PostHogRecording,
      appBase,
      PROJECT_ID,
    );
    expect(item).toMatchObject({
      lane: "flow",
      kind: "posthog.recording",
      before: null,
      after: null,
      ref: { provider: "posthog", id: "rec-EXAMPLE-0001" },
      whenObserved: Date.parse("2026-07-08T12:30:00.000Z"),
    });
    expect(item.brief).toBe("session recording rec-EXAMPLE-0001 (3m 20s)");
    // The value IS the replay player deep link — the recording is never downloaded.
    expect(item.ref.url).toBe(
      "https://us.posthog.com/project/1/replay/rec-EXAMPLE-0001",
    );
  });

  it("formats recording durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(200)).toBe("3m 20s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(undefined)).toBe("unknown");
  });
});

describe("PostHogEvidenceSource.fetchEvidence — end to end (fixtures)", () => {
  it("returns events + recordings, key+UA on every request, query params on the wire", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { user: "user-42", sessionId: "sess-abc-123" } }),
    );

    // 2 events + 1 recording.
    expect(result.items.filter((i) => i.kind === "posthog.event")).toHaveLength(
      2,
    );
    expect(
      result.items.filter((i) => i.kind === "posthog.recording"),
    ).toHaveLength(1);
    expect(result.stats).toMatchObject({
      provider: "posthog",
      fetched: 3,
      returned: 3,
    });

    const eventsReq = requests.find((r) => r.url.includes("/events"))!;
    expect(eventsReq.url).toContain("distinct_id=user-42");
    expect(eventsReq.url).toContain("after=2026-07-08T00%3A00%3A00.000Z");
    expect(decodeURIComponent(eventsReq.url)).toContain('"$session_id"');

    const recReq = requests.find((r) => r.url.includes("/session_recordings"))!;
    expect(recReq.url).toContain("distinct_id=user-42");
    expect(decodeURIComponent(recReq.url)).toContain(
      'session_ids=["sess-abc-123"]',
    );

    for (const req of requests) {
      expect(req.headers["User-Agent"]).toBe(CRUMBTRAIL_USER_AGENT);
      expect(req.headers["Authorization"]).toBe(
        "Bearer phx-personal-key-secret",
      );
    }
  });

  it("NEVER fetches recording content — only the list endpoint (LINK-ONLY)", async () => {
    const { source, requests } = makeSource();
    const result = await source.fetchEvidence(
      query({ keys: { user: "user-42" } }),
    );

    // Exactly one recordings request, and it is the LIST endpoint, not a blob.
    const recRequests = requests.filter((r) =>
      r.url.includes("/session_recordings"),
    );
    expect(recRequests).toHaveLength(1);
    expect(recRequests[0].url).toMatch(/\/session_recordings\/\?/);
    // No snapshot/content or single-recording detail fetch happened.
    expect(requests.some((r) => r.url.includes("/snapshots"))).toBe(false);
    expect(
      requests.some((r) => /\/session_recordings\/[^/?]+\//.test(r.url)),
    ).toBe(false);
    // And the recording item stored zero content.
    const rec = result.items.find((i) => i.kind === "posthog.recording")!;
    expect(rec.before).toBeNull();
    expect(rec.after).toBeNull();
    expect(rec.ref.url).toContain("/replay/");
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

  it("re-throws a primary (events) failure so the framework makes it a gap + ok:false", async () => {
    const { source } = makeSource({ failEvents: true });
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { user: "u" } }),
    );
    expect(out.items).toHaveLength(0);
    expect(
      out.gaps.some((g) => g.reason.includes("posthog: fetch failed")),
    ).toBe(true);
    const stat = out.stats.find((s) => s.provider === "posthog");
    expect(stat?.ok).toBe(false);
    expect(stat?.error).not.toContain("phx-personal-key-secret");
  });
});

describe("PostHogEvidenceSource — resilience / two-API fetch", () => {
  it("still returns the primary event items when the recordings list out-runs its budget", async () => {
    const { source } = makeSource({ slowRecordings: true });
    const result = await source.fetchEvidence(
      query({
        keys: { user: "user-42" },
        limits: { ...LIMITS, timeoutMs: 40 },
      }),
    );
    expect(result.items.filter((i) => i.kind === "posthog.event")).toHaveLength(
      2,
    );
    expect(
      result.items.filter((i) => i.kind === "posthog.recording"),
    ).toHaveLength(0);
    expect(
      result.gaps.some((g) =>
        g.reason.includes("session-recordings list did not complete"),
      ),
    ).toBe(true);
  });

  it("preserves the event items through fetchAdapterEvidence when recordings out-run the framework timeout", async () => {
    const { source } = makeSource({ slowRecordings: true });
    const out = await fetchAdapterEvidence(
      [source],
      query({
        keys: { user: "user-42" },
        limits: { ...LIMITS, timeoutMs: 80 },
      }),
    );
    expect(out.items.filter((i) => i.kind === "posthog.event")).toHaveLength(2);
    const stat = out.stats.find((s) => s.provider === "posthog");
    expect(stat?.ok).toBe(true);
  });
});

describe("PostHogEvidenceSource — health()", () => {
  it("reports ok on a 200 from the project endpoint", async () => {
    const { source, requests } = makeSource();
    const health = await source.health();
    expect(health).toMatchObject({ ok: true, provider: "posthog" });
    expect(requests[0].url).toContain("/api/projects/1/");
  });

  it("reports a sanitized error on failure (no key in the message)", async () => {
    const source = new PostHogEvidenceSource({
      apiKey: "phx-personal-key-secret",
      projectId: PROJECT_ID,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    const health = await source.health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("401");
    expect(health.error).not.toContain("phx-personal-key-secret");
  });
});

describe("redaction boundary (via fetchAdapterEvidence)", () => {
  it("scrubs a token embedded in an event property (after) while keeping the deep link", async () => {
    const { source } = makeSource();
    const out = await fetchAdapterEvidence(
      [source],
      query({ keys: { user: "user-42" } }),
    );
    const errEvent = out.items.find(
      (i) => i.kind === "posthog.event" && i.id.endsWith("event-0002"),
    )!;
    expect(JSON.stringify(errEvent.after)).not.toContain("abcdef0123456789");
    expect(JSON.stringify(errEvent.after)).toContain("[REDACTED]");
    expect(errEvent.ref.url).toContain("/person/user-42");
  });
});

describe("registry wiring", () => {
  it("declares the PostHog descriptor", () => {
    expect(POSTHOG_DESCRIPTOR).toMatchObject({
      provider: "posthog",
      displayName: "PostHog",
      lanes: ["browser", "flow"],
      joinKeys: ["user", "sessionId", "url", "time"],
    });
  });

  it("evidenceSourcesFromEnv returns a PostHog source when its env vars are set", () => {
    registerEvidenceProvider(posthogEvidenceProvider); // idempotent
    const env = {
      [POSTHOG_API_KEY_ENV]: "key",
      [POSTHOG_PROJECT_ID_ENV]: "1",
      [POSTHOG_HOST_ENV]: "https://eu.posthog.com",
    };
    const sources = evidenceSourcesFromEnv(env);
    expect(sources.map((s) => s.descriptor.provider)).toContain("posthog");
  });

  it("omits PostHog when a required var (project id) is missing", () => {
    const sources = evidenceSourcesFromEnv({ [POSTHOG_API_KEY_ENV]: "key" });
    expect(sources.map((s) => s.descriptor.provider)).not.toContain("posthog");
  });
});
