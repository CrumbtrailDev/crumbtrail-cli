import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  buildDistinctBugSignature,
  groupDistinctBugRecurrences,
  groupDistinctBugs,
  type DistinctBug,
  type DistinctBugRecurrenceInput,
} from "../distinct-bugs";
import { computeDistinctBugSignatures } from "../index";
import type { EvidenceCandidate } from "../evidence-index";

function candidate(
  overrides: Partial<EvidenceCandidate> &
    Pick<EvidenceCandidate, "id" | "detector" | "anchor">,
): EvidenceCandidate {
  return {
    schemaVersion: 1,
    title: `${overrides.detector} candidate`,
    severity: "medium",
    score: 50,
    confidence: "high",
    evidenceWindow: {
      start: overrides.anchor.t - 15,
      end: overrides.anchor.t + 45,
      windowId: "win_0001",
    },
    ...overrides,
  } as EvidenceCandidate;
}

// Two distinct failures + a duplicate of one:
//  - Bug A: a front-end HTTP 500 correlated (same requestId) to a back-end OTel span error.
//  - Bug B: a console error, plus a second identical console error shortly after (the duplicate).
const FIXTURE: EvidenceCandidate[] = [
  candidate({
    id: "cand_0001",
    detector: "http_error",
    title: "HTTP 500 from POST /api/pay",
    severity: "high",
    score: 90,
    anchor: {
      t: 1000,
      offsetMs: 0,
      route: "/checkout",
      requestId: "req-A",
      method: "POST",
      url: "/api/pay",
      status: 500,
      message: "HTTP 500",
    },
    evidenceWindow: { start: 985, end: 1045, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0002",
    detector: "otel_span_error",
    title: "OTel span error (HTTP 500): POST /api/pay [api]",
    severity: "high",
    score: 88,
    anchor: {
      t: 1010,
      offsetMs: 10,
      route: "/checkout",
      requestId: "req-A",
      status: 500,
      message: "upstream failed",
      source: "api",
    },
    evidenceWindow: { start: 995, end: 1055, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0003",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2000,
      offsetMs: 1000,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 1985, end: 2045, windowId: "win_0002" },
  }),
  candidate({
    id: "cand_0004",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2200,
      offsetMs: 1200,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 2185, end: 2245, windowId: "win_0002" },
  }),
];

describe("groupDistinctBugs", () => {
  it("groups two distinct failures and dedups a repeat into exactly two stable bugs", () => {
    const bugs = groupDistinctBugs(FIXTURE);

    expect(bugs).toHaveLength(2);

    // Deterministic ordering: severity desc (high before medium), then firstSeen, then bugId.
    const [bugA, bugB] = bugs;

    // Stable, deterministic ids locked to detect any drift in the dedup-key derivation.
    expect(bugA.bugId).toBe("bug_otjiny");
    expect(bugB.bugId).toBe("bug_1pg6ltd");

    // Bug A: correlated front-end + back-end share one requestId, so front/back land together.
    expect(bugA.severity).toBe("high");
    expect(bugA.requestIds).toEqual(["req-A"]);
    expect(bugA.firstSeen).toBe(1000);
    expect(bugA.lastSeen).toBe(1010);
    expect(bugA.window).toEqual({ start: 985, end: 1055 });
    expect(bugA.candidateIds).toEqual(["cand_0001", "cand_0002"]);
    expect(bugA.frontendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0001",
    ]);
    expect(bugA.backendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0002",
    ]);
    expect(bugA.representative).toMatchObject({
      detector: "http_error",
      requestId: "req-A",
      method: "POST",
      status: 500,
    });
    expect(bugA.frontendEvidence[0]).toMatchObject({
      method: "POST",
      status: 500,
    });

    // Bug B: the duplicate console error collapsed into the same bug.
    expect(bugB.severity).toBe("medium");
    expect(bugB.requestIds).toEqual([]);
    expect(bugB.candidateIds).toEqual(["cand_0003", "cand_0004"]);
    expect(bugB.frontendEvidence).toHaveLength(2);
    expect(bugB.backendEvidence).toHaveLength(0);
    expect(bugB).not.toHaveProperty("dbDiffs");
  });

  it("is deterministic regardless of input order", () => {
    const forward = groupDistinctBugs(FIXTURE);
    const reversed = groupDistinctBugs([...FIXTURE].reverse());
    expect(reversed).toEqual(forward);
  });

  it("returns an empty list for no candidates", () => {
    expect(groupDistinctBugs([])).toEqual([]);
  });

  it("carries bounded, redacted bodies for the representative's correlated failed request", () => {
    const representative = candidate({
      id: "cand_body",
      detector: "http_error",
      title: "HTTP 500 from POST /api/pay",
      severity: "high",
      score: 90,
      anchor: {
        t: 1_100,
        requestId: "body-request",
        method: "POST",
        status: 500,
      },
    });
    const events: BugEvent[] = [
      {
        t: 1_000,
        k: "net.req",
        d: { id: "body-request", body: "apiKey=supersecret-key&amount=42" },
      },
      {
        t: 1_100,
        k: "net.res",
        d: {
          id: "body-request",
          st: 500,
          body: { error: "payment failed", token: "supersecret-token" },
        },
      },
    ];

    const [bug] = groupDistinctBugs([representative], events);

    expect(bug.representative.bodySnippet).toMatchObject({
      request: expect.stringContaining("[REDACTED_KEY]="),
      response: expect.stringContaining("[REDACTED_KEY]"),
    });
    expect(bug.representative.bodySnippet?.request).toContain("amount=42");
    expect(bug.representative.bodySnippet?.response).toContain(
      "payment failed",
    );
    expect(JSON.stringify(bug.representative.bodySnippet)).not.toContain(
      "supersecret",
    );
    expect(bug.representative.bodySnippet?.request?.length).toBeLessThanOrEqual(
      300,
    );
    expect(
      bug.representative.bodySnippet?.response?.length,
    ).toBeLessThanOrEqual(300);
  });

  it("omits the representative body snippet when the failed request has no bodies", () => {
    const representative = candidate({
      id: "cand_body_absent",
      detector: "network_error",
      title: "Network error from POST /api/pay",
      severity: "high",
      score: 86,
      anchor: { t: 1_100, requestId: "bodyless-request", method: "POST" },
    });
    const events: BugEvent[] = [
      { t: 1_000, k: "net.req", d: { id: "bodyless-request" } },
      { t: 1_100, k: "net.err", d: { id: "bodyless-request" } },
    ];

    const [bug] = groupDistinctBugs([representative], events);

    expect(bug.representative).not.toHaveProperty("bodySnippet");
  });

  it("carries the anchor's source location onto the representative", () => {
    const [bug] = groupDistinctBugs([
      candidate({
        id: "cand_framed",
        detector: "backend_request_error",
        title: "Backend error from GET /api/search",
        severity: "high",
        score: 90,
        anchor: {
          t: 1_200,
          route: "/api/search",
          frame: "src/routes/search.js:61:33",
        },
      }),
    ]);

    expect(bug.representative.frame).toBe("src/routes/search.js:61:33");
  });

  it("omits the representative frame when the anchor named no source location", () => {
    const [bug] = groupDistinctBugs([
      candidate({
        id: "cand_frameless",
        detector: "backend_request_error",
        title: "Backend error from GET /api/search",
        severity: "high",
        score: 90,
        anchor: { t: 1_200, route: "/api/search" },
      }),
    ]);

    expect(bug.representative).not.toHaveProperty("frame");
  });

  it("carries target descriptors into distinct bug evidence and signatures", () => {
    const bugs = groupDistinctBugs([
      candidate({
        id: "cand_target_a",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1000,
          message: "3 clicks within 3s",
          target: {
            role: "button",
            label: "Submit order",
            testID: "submit-order",
            accessibilityId: "checkout.submit",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:primary",
          },
        },
      }),
      candidate({
        id: "cand_target_b",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1200,
          message: "3 clicks within 3s",
          target: {
            role: "button",
            label: "Cancel order",
            testID: "cancel-order",
            accessibilityId: "checkout.cancel",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:secondary",
          },
        },
      }),
    ]);

    expect(bugs).toHaveLength(2);
    expect(bugs.map((bug) => bug.representative.target?.testID).sort()).toEqual(
      ["cancel-order", "submit-order"],
    );
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.routePath),
      ),
    ).toEqual(["/checkout", "/checkout"]);
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.componentName),
      ),
    ).toEqual(["Pressable", "Pressable"]);
  });
});

describe("groupDistinctBugs — route-agnostic beacon collapse (CRUMB-94)", () => {
  const rejection = (id: string, t: number, route: string) =>
    candidate({
      id,
      detector: "unhandled_rejection",
      title: "Unhandled rejection: Failed to fetch",
      severity: "low",
      score: 15,
      anchor: { t, route, message: "Failed to fetch" },
      evidenceWindow: { start: t - 15, end: t + 45, windowId: `win_${id}` },
    });

  const spread: EvidenceCandidate[] = [
    rejection("cand_r1", 1_000, "https://alertbase.ai/dashboard/jobs"),
    rejection("cand_r2", 90_000, "https://alertbase.ai/dashboard/billing"),
    rejection("cand_r3", 180_000, "https://alertbase.ai/dashboard/settings"),
    rejection("cand_r4", 270_000, "https://alertbase.ai/dashboard/jobs?tab=2"),
    rejection("cand_r5", 360_000, "https://alertbase.ai/dashboard/reports"),
  ];

  it("collapses N same-signature rejections across URLs into one bug with occurrence info", () => {
    const bugs = groupDistinctBugs(spread);

    expect(bugs).toHaveLength(1);
    const [bug] = bugs;
    expect(bug.occurrenceCount).toBe(5);
    expect(bug.affectedUrls).toHaveLength(5);
    // Per-occurrence evidence windows are preserved on the single merged bug.
    expect(bug.frontendEvidence).toHaveLength(5);
    expect(bug.candidateIds).toEqual([
      "cand_r1",
      "cand_r2",
      "cand_r3",
      "cand_r4",
      "cand_r5",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    expect(groupDistinctBugs([...spread].reverse())).toEqual(
      groupDistinctBugs(spread),
    );
  });

  it("keeps a real first-party failure ranked above the collapsed beacon noise", () => {
    const firstParty = candidate({
      id: "cand_http",
      detector: "http_error",
      title: "HTTP 404 from GET /api/jobs",
      severity: "medium",
      score: 70,
      anchor: {
        t: 5_000,
        route: "/dashboard/jobs",
        method: "GET",
        status: 404,
        message: "HTTP 404",
      },
    });

    const bugs = groupDistinctBugs([...spread, firstParty]);

    // One collapsed beacon bug + one first-party bug, first-party ranked first (severity desc).
    expect(bugs).toHaveLength(2);
    expect(bugs[0].representative.detector).toBe("http_error");
    expect(bugs[0].severity).toBe("medium");
    expect(bugs[1].representative.detector).toBe("unhandled_rejection");
    expect(bugs[1].severity).toBe("low");
    expect(bugs[1].occurrenceCount).toBe(5);
  });
});

describe("buildDistinctBugSignature", () => {
  function bugFor(id: string, message: string) {
    return groupDistinctBugs([
      candidate({
        id,
        detector: "console_error",
        title: message,
        anchor: { t: 1000, message, route: "/checkout" },
      }),
    ])[0];
  }

  function signatureOf(id: string, message: string) {
    return buildDistinctBugSignature(bugFor(id, message));
  }

  // Each pair is ONE fault parameterised twice, and each used to mint two signatures —
  // so a recurring failure arrived as a list of singletons with nothing to count.
  it.each([
    [
      "a quoted flag name",
      "Unknown feature flag 'beta-checkout'",
      "Unknown feature flag 'beta-payments'",
    ],
    [
      "an email address",
      "Cannot find user alice@example.com",
      "Cannot find user bob@example.com",
    ],
    [
      "a chunk hash",
      "Failed to load module chunk-abcdefabcdef",
      "Failed to load module chunk-fedcbafedcba",
    ],
    [
      "a prefixed order id",
      "Checkout failed for order ord_7885f1c8",
      "Checkout failed for order ord_1a2b3c4d",
    ],
    [
      "a uuid",
      "Session 4f1c2b3a-1111-2222-3333-444455556666 expired",
      "Session 9a8b7c6d-9999-8888-7777-666655554444 expired",
    ],
  ])("collapses two occurrences differing only by %s", (_label, a, b) => {
    expect(signatureOf("cand_a", a)).toEqual(signatureOf("cand_b", b));
  });

  it("keeps genuinely different faults apart", () => {
    // The status code survives the digit collapse on purpose: two statuses on one
    // route are two failures with two fixes.
    expect(signatureOf("cand_a", "HTTP 403 from POST /login")).not.toEqual(
      signatureOf("cand_b", "HTTP 500 from POST /login"),
    );
    // A snake_case identifier is a fault's name, not a generated id, so it stands.
    expect(signatureOf("cand_a", "Payment payment_declined")).not.toEqual(
      signatureOf("cand_b", "Payment payment_disputed"),
    );
    expect(signatureOf("cand_a", "Cannot read total")).not.toEqual(
      signatureOf("cand_b", "Cannot read subtotal"),
    );
    // A url's PATH is identity, so two endpoints stay two bugs.
    expect(signatureOf("cand_a", "HTTP 404 from GET /v2/search")).not.toEqual(
      signatureOf("cand_b", "HTTP 404 from GET /v2/orders"),
    );
  });

  it("normalizes numeric message values across sessions", () => {
    const invoiceA = groupDistinctBugs([
      candidate({
        id: "cand_invoice_a",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 123 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const invoiceB = groupDistinctBugs([
      candidate({
        id: "cand_invoice_b",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 456 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdA = groupDistinctBugs([
      candidate({
        id: "cand_threshold_a",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 2 approvals but got 3",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdB = groupDistinctBugs([
      candidate({
        id: "cand_threshold_b",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 7 approvals but got 8",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];

    expect(buildDistinctBugSignature(invoiceA)).toBe(
      buildDistinctBugSignature(invoiceB),
    );
    expect(buildDistinctBugSignature(thresholdA)).toBe(
      buildDistinctBugSignature(thresholdB),
    );
  });

  it("collapses the production route variants into one version-2 signature", () => {
    const bug = (route: string) => ({
      title: "Unhandled rejection: Failed to fetch",
      representative: {
        title: "Unhandled rejection: Failed to fetch",
        detector: "unhandled_rejection",
        severity: "high" as const,
        message: "Unhandled rejection: Failed to fetch",
        route,
      },
    });

    const signatures = [
      "https://alertbase.ai/dashboard/jobs",
      "https://alertbase.ai/dashboard/jobs?tab=2",
      "/dashboard/jobs#x",
    ].map((route) => buildDistinctBugSignature(bug(route)));

    expect(signatures).toEqual([signatures[0], signatures[0], signatures[0]]);
    expect(signatures[0]).toMatch(/^bugsig2:/);
  });

  it("collapses UUID and hexadecimal route segments", () => {
    const bug = (route: string) => ({
      title: "Job request failed",
      representative: {
        title: "Job request failed",
        detector: "http_error",
        severity: "high" as const,
        message: "Job request failed",
        route,
      },
    });

    const idSignature = buildDistinctBugSignature(bug("/jobs/:id"));

    expect(
      buildDistinctBugSignature(
        bug("/jobs/550e8400-e29b-41d4-a716-446655440000"),
      ),
    ).toBe(idSignature);
    expect(buildDistinctBugSignature(bug("/jobs/deadbeef"))).toBe(idSignature);
    expect(buildDistinctBugSignature(bug("/jobs/feedback"))).not.toBe(
      idSignature,
    );
    expect(buildDistinctBugSignature(bug("/jobs/dashboard"))).not.toBe(
      idSignature,
    );
  });

  it("keeps genuinely different routes distinct", () => {
    const bug = (route: string) => ({
      title: "Request failed",
      representative: {
        title: "Request failed",
        detector: "http_error",
        severity: "high" as const,
        message: "Request failed",
        route,
      },
    });

    expect(buildDistinctBugSignature(bug("/jobs"))).not.toBe(
      buildDistinctBugSignature(bug("/billing")),
    );
  });

  it("returns the exact legacy signature for cutover matching", () => {
    const signatures = computeDistinctBugSignatures({
      title: "Unhandled rejection: Failed to fetch",
      representative: {
        title: "Unhandled rejection: Failed to fetch",
        detector: "unhandled_rejection",
        severity: "high",
        message: "Unhandled rejection: Failed to fetch",
        route: "https://alertbase.ai/dashboard/jobs?tab=2#x",
      },
    });

    expect(signatures.legacy).toBe("bugsig:1du09jm");
    expect(
      buildDistinctBugSignature({
        title: "Unhandled rejection: Failed to fetch",
        representative: {
          title: "Unhandled rejection: Failed to fetch",
          detector: "unhandled_rejection",
          severity: "high",
          message: "Unhandled rejection: Failed to fetch",
          route: "https://alertbase.ai/dashboard/jobs?tab=2#x",
        },
      }),
    ).toBe(signatures.current);
  });
});

// A write path that trips two detectors per attempt produced one bug per
// attempt: eight retries of the same defect answered as eight distinct bugs
// carrying one signature. Only singleton request clusters used to fold.
describe("repeated multi-candidate request clusters", () => {
  function attempt(n: number): EvidenceCandidate[] {
    const t = 5000 + n * 1000;
    return [
      candidate({
        id: `cand_${n}a`,
        detector: "mutations_missing_entity_audit",
        title: "2 dispatch_jobs mutations had no matching entity audit",
        severity: "high",
        score: 93,
        anchor: {
          t,
          offsetMs: t,
          route: "/board",
          requestId: `req-${n}`,
          message: "The request mutated 2 dispatch_jobs rows",
        },
        evidenceWindow: { start: t - 10, end: t + 50, windowId: "win_0001" },
      }),
      candidate({
        id: `cand_${n}b`,
        detector: "db_mutation",
        title: "Database update on dispatch_jobs",
        severity: "medium",
        score: 40,
        anchor: {
          t: t + 5,
          offsetMs: t + 5,
          route: "/board",
          requestId: `req-${n}`,
          message: "Database update on dispatch_jobs",
        },
        evidenceWindow: { start: t - 10, end: t + 50, windowId: "win_0001" },
      }),
    ];
  }

  const events: BugEvent[] = [];

  it("folds identical attempts into one bug", () => {
    const bugs = groupDistinctBugs(
      [0, 1, 2, 3].flatMap((n) => attempt(n)),
      events,
    );
    expect(bugs).toHaveLength(1);
    expect(bugs[0].requestIds).toHaveLength(4);
    expect(new Set(bugs.map((b) => b.title)).size).toBe(1);
  });

  it("keeps a request whose signal combination is unique", () => {
    const odd = attempt(9)[0];
    const bugs = groupDistinctBugs(
      [...[0, 1, 2].flatMap((n) => attempt(n)), odd],
      events,
    );
    expect(bugs).toHaveLength(2);
  });
});

// The recurrence signature used to run `\d+` -> `#` over the whole message, so
// "HTTP 403 from POST /login" and "HTTP 500 from POST /login" hashed to one
// canonical issue. The cloud's grouping layer keeps 403 and 500 apart; identity
// must not re-merge them here.
describe("http status codes survive signature normalization", () => {
  const httpBug = (status: number) => ({
    title: `HTTP ${status} from POST /api/login`,
    representative: {
      title: `HTTP ${status} from POST /api/login`,
      detector: "http_error",
      severity: "high" as const,
      message: `HTTP ${status} from POST /api/login`,
      route: "/login",
      method: "POST",
      status,
    },
  });

  it("keeps a 403 and a 500 on one endpoint distinct", () => {
    expect(buildDistinctBugSignature(httpBug(403))).not.toBe(
      buildDistinctBugSignature(httpBug(500)),
    );
  });

  it("keeps axios-style status-code phrasing distinct", () => {
    const bug = (status: number) => ({
      title: "Request failed",
      representative: {
        title: "Request failed",
        detector: "http_error",
        severity: "high" as const,
        message: `Request failed with status code ${status}`,
        route: "/login",
      },
    });
    expect(buildDistinctBugSignature(bug(404))).not.toBe(
      buildDistinctBugSignature(bug(502)),
    );
  });

  it("still collapses genuinely variable numbers", () => {
    const bug = (id: number) => ({
      title: "Invoice missing",
      representative: {
        title: "Invoice missing",
        detector: "db_mutation",
        severity: "high" as const,
        message: `Invoice ${id} ranked 3 instead of 1`,
        route: "/jobs/invoice-digest",
      },
    });
    expect(buildDistinctBugSignature(bug(123))).toBe(
      buildDistinctBugSignature(bug(4567)),
    );
  });

  it("keeps in-session 403 and 500 clusters apart", () => {
    const bugs = groupDistinctBugs([
      candidate({
        id: "cand_403",
        detector: "http_error",
        title: "HTTP 403 from POST /api/login",
        severity: "high",
        score: 70,
        anchor: {
          t: 1000,
          route: "/login",
          requestId: "req-403",
          method: "POST",
          url: "https://app.example.com/api/login",
          status: 403,
        },
      }),
      candidate({
        id: "cand_500",
        detector: "http_error",
        title: "HTTP 500 from POST /api/login",
        severity: "high",
        score: 90,
        anchor: {
          t: 1200,
          route: "/login",
          requestId: "req-500",
          method: "POST",
          url: "https://app.example.com/api/login",
          status: 500,
        },
      }),
    ]);
    expect(bugs).toHaveLength(2);
    expect(
      new Set(bugs.map((bug) => buildDistinctBugSignature(bug))).size,
    ).toBe(2);
  });
});

// The failing request's url reached the anchor and then stopped: representative
// and the evidence refs had no url field, so the cloud could not build a
// resource-level route key and unrelated single-page-app failures merged.
describe("the failing request url reaches the representative", () => {
  const bugs = groupDistinctBugs([
    candidate({
      id: "cand_url",
      detector: "http_error",
      title: "HTTP 500 from POST /api/pay",
      severity: "high",
      score: 90,
      anchor: {
        t: 1000,
        route: "/checkout",
        requestId: "req-url",
        method: "POST",
        url: "https://app.example.com/api/pay",
        status: 500,
      },
    }),
  ]);

  it("carries anchor.url onto representative", () => {
    expect(bugs[0].representative.url).toBe("https://app.example.com/api/pay");
  });

  it("carries anchor.url onto the evidence ref", () => {
    expect(bugs[0].frontendEvidence[0].url).toBe(
      "https://app.example.com/api/pay",
    );
  });

  it("omits url when the candidate has none", () => {
    const [bug] = groupDistinctBugs([
      candidate({
        id: "cand_nourl",
        detector: "console_error",
        title: "Console error: boom",
        anchor: { t: 1000, message: "boom" },
      }),
    ]);
    expect("url" in bug.representative).toBe(false);
    expect("url" in bug.frontendEvidence[0]).toBe(false);
  });
});

describe("evidence lanes are decided by the detector's name", () => {
  function laneBug(detector: string, requestId: string) {
    return candidate({
      id: `cand_${detector}`,
      detector,
      title: `${detector} fired`,
      severity: "high",
      score: 90,
      anchor: {
        t: 1000,
        offsetMs: 0,
        route: "/checkout",
        requestId,
        method: "POST",
        url: "/internal/invoices/finalize",
        status: 500,
        message: `${detector} message`,
      },
    });
  }

  it("files a backend_* detector on the backend lane, not the frontend one", () => {
    const [bug] = groupDistinctBugs([
      laneBug("backend_request_error", "req-backend"),
    ]);
    expect(bug.backendEvidence.map((ref) => ref.detector)).toEqual([
      "backend_request_error",
    ]);
    expect(bug.frontendEvidence).toEqual([]);
  });

  it("keeps otel_* on the backend lane and otel_db_* on the db lane", () => {
    const [span] = groupDistinctBugs([laneBug("otel_span_error", "req-span")]);
    expect(span.backendEvidence.length).toBe(1);

    const [db] = groupDistinctBugs([
      laneBug("otel_db_activity", "req-otel-db"),
    ]);
    expect(db.dbDiffs?.map((ref) => ref.detector)).toEqual([
      "otel_db_activity",
    ]);
    expect(db.frontendEvidence).toEqual([]);
  });

  it("keeps db_* and duplicate_write on the db lane", () => {
    for (const detector of [
      "db_statement_failed",
      "db_mutation",
      "duplicate_write",
    ]) {
      const [bug] = groupDistinctBugs([laneBug(detector, `req-${detector}`)]);
      expect(bug.dbDiffs?.map((ref) => ref.detector)).toEqual([detector]);
    }
  });

  it("leaves a browser-observed detector on the frontend lane", () => {
    for (const detector of ["http_error", "console_error", "network_error"]) {
      const [bug] = groupDistinctBugs([laneBug(detector, `req-${detector}`)]);
      expect(bug.frontendEvidence.map((ref) => ref.detector)).toEqual([
        detector,
      ]);
      expect(bug.backendEvidence).toEqual([]);
    }
  });

  it("counts each plane once for a full-stack bug correlated on one request", () => {
    const [bug] = groupDistinctBugs([
      laneBug("http_error", "req-full"),
      laneBug("backend_request_error", "req-full"),
      laneBug("db_statement_failed", "req-full"),
    ]);
    expect({
      frontend: bug.frontendEvidence.length,
      backend: bug.backendEvidence.length,
      db: bug.dbDiffs?.length ?? 0,
    }).toEqual({ frontend: 1, backend: 1, db: 1 });
  });
});

describe("a query string is data, not identity", () => {
  function searchFailure(id: string, url: string, t: number) {
    return candidate({
      id,
      detector: "http_error",
      title: `HTTP 404 from GET ${url}`,
      severity: "medium",
      score: 70,
      anchor: {
        t,
        offsetMs: 0,
        route: "/search",
        requestId: id,
        method: "GET",
        url,
        status: 404,
      },
    });
  }

  const plain = "https://api.example.com/v2/search";
  const queried = "https://api.example.com/v2/search?q=%5BREDACTED%5D";

  it("collapses two failures on one endpoint that differ only in query string", () => {
    const bugs = groupDistinctBugs([
      searchFailure("req-1", plain, 1000),
      searchFailure("req-2", queried, 1200),
    ]);
    expect(bugs.length).toBe(1);
  });

  it("gives them one recurrence signature", () => {
    expect(
      buildDistinctBugSignature({
        title: `HTTP 404 from GET ${plain}`,
        representative: {
          detector: "http_error",
          title: `HTTP 404 from GET ${plain}`,
          route: plain,
          severity: "medium",
        },
      } as never),
    ).toBe(
      buildDistinctBugSignature({
        title: `HTTP 404 from GET ${queried}`,
        representative: {
          detector: "http_error",
          title: `HTTP 404 from GET ${queried}`,
          route: queried,
          severity: "medium",
        },
      } as never),
    );
  });

  it("keeps the full url, query included, on the evidence payload", () => {
    const [bug] = groupDistinctBugs([searchFailure("req-2", queried, 1200)]);
    expect(bug.representative.url).toBe(queried);
    expect(bug.frontendEvidence[0].url).toBe(queried);
  });

  it("still separates two different endpoints and two different statuses", () => {
    expect(
      groupDistinctBugs([
        searchFailure("req-1", plain, 1000),
        searchFailure("req-3", "https://api.example.com/v2/orders", 1200),
      ]).length,
    ).toBe(2);
  });
});

/**
 * CT-P03 at the rollup layer: a session that recorded no app name contributed
 * nothing to `apps` and left no marker, so the rollup answered "which apps does
 * this affect" with `[]` — "none" — when the true answer was "unknown".
 */
describe("recurrence label rollups", () => {
  function input(
    sessionId: string,
    session: Partial<DistinctBugRecurrenceInput["session"]> = {},
  ): DistinctBugRecurrenceInput {
    const bug = {
      schemaVersion: 1,
      bugId: `bug_${sessionId}`,
      title: "Wrong invoice rank",
      severity: "high",
      firstSeen: 100,
      lastSeen: 200,
      window: { start: 100, end: 200 },
      representative: {
        title: "Wrong invoice rank",
        detector: "db_mutation",
        severity: "high",
        message: "Invoice ranked 3 instead of 1",
        route: "/jobs/invoice-digest",
      },
      frontendEvidence: [],
      backendEvidence: [],
      candidateIds: [],
    } as unknown as DistinctBug;
    return { bug, session: { sessionId, ...session } };
  }

  it("counts sessions with no app name as unknown instead of dropping them", () => {
    const [rollup] = groupDistinctBugRecurrences([
      input("s1", { app: "billing" }),
      input("s2"),
      input("s3"),
    ]);
    expect(rollup.session_count).toBe(3);
    expect(rollup.apps).toEqual({ known: ["billing"], unknown: 2 });
  });

  it("omits tenants entirely when no session carried one", () => {
    const [rollup] = groupDistinctBugRecurrences([
      input("s1", { app: "billing" }),
      input("s2", { app: "billing" }),
    ]);
    expect(rollup.tenants).toBeUndefined();
    expect(Object.keys(rollup)).not.toContain("tenants");
  });

  it("reports tenants with their own unknown count once any session has one", () => {
    const [rollup] = groupDistinctBugRecurrences([
      input("s1", { app: "billing", tenant: "acme" }),
      input("s2", { app: "billing" }),
    ]);
    expect(rollup.tenants).toEqual({ known: ["acme"], unknown: 1 });
  });

  it("counts unknown per session, not per occurrence", () => {
    const two = input("s1");
    const alsoTwo = input("s1");
    alsoTwo.bug = { ...alsoTwo.bug, bugId: "bug_s1_second" };
    const [rollup] = groupDistinctBugRecurrences([two, alsoTwo]);
    expect(rollup.session_count).toBe(1);
    expect(rollup.apps).toEqual({ known: [], unknown: 1 });
  });
});

describe("a resource id inside a message is data, not identity", () => {
  function throttled(asin: string) {
    const message = `Backend logged warn: SP-API throttled (429) /products/fees/v0/items/${asin}/feesEstimate`;
    return {
      title: message,
      representative: {
        detector: "backend_log_warn",
        title: message,
        message,
        route: "",
        severity: "medium",
      },
    } as never;
  }

  it("gives two occurrences of one throttled endpoint one signature", () => {
    expect(buildDistinctBugSignature(throttled("B07VBB6HTX"))).toBe(
      buildDistinctBugSignature(throttled("B0GK35JP5Q")),
    );
  });

  it("keeps two different endpoints apart", () => {
    const other =
      "Backend logged warn: SP-API throttled (429) /orders/v0/orders/B07VBB6HTX/items";
    expect(buildDistinctBugSignature(throttled("B07VBB6HTX"))).not.toBe(
      buildDistinctBugSignature({
        title: other,
        representative: {
          detector: "backend_log_warn",
          title: other,
          message: other,
          route: "",
          severity: "medium",
        },
      } as never),
    );
  });

  it("keeps two statuses on one endpoint apart", () => {
    const throttleMessage =
      "Backend logged warn: SP-API status 429 /products/fees/v0/items/B07VBB6HTX/feesEstimate";
    const serverMessage =
      "Backend logged warn: SP-API status 500 /products/fees/v0/items/B0GK35JP5Q/feesEstimate";
    const sig = (message: string) =>
      buildDistinctBugSignature({
        title: message,
        representative: {
          detector: "backend_log_warn",
          title: message,
          message,
          route: "",
          severity: "medium",
        },
      } as never);
    expect(sig(throttleMessage)).not.toBe(sig(serverMessage));
  });

  it("leaves a host untouched, so two hosts stay apart", () => {
    const sig = (host: string) => {
      const message = `HTTP 500 from GET https://${host}/v2/orders`;
      return buildDistinctBugSignature({
        title: message,
        representative: {
          detector: "http_error",
          title: message,
          message,
          route: "",
          severity: "medium",
        },
      } as never);
    };
    expect(sig("eu1.example.com")).not.toBe(sig("us2.example.com"));
  });
});
