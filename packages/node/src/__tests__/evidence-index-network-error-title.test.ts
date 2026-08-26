import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// A network-error title is a headline, not an evidence dump. Redaction expands
// every query value into an escaped `[REDACTED]`, so carrying the query string
// into the title produced several-hundred-character headlines. The title keeps
// origin + path; the anchor keeps the full redacted URL.
describe("buildEvidenceCandidates — network_error title", () => {
  const analyticsUrl =
    "https://www.google.com/g/collect?v=2&tid=G-XYZ&gtm=abc&_p=1&gcs=G111&gcd=1v1&npa=0&dma_cps=x&dma=0";

  function candidateFor(url: string, method = "POST") {
    const events: BugEvent[] = [{ t: 1000, k: "net.err", d: { id: "r1", url } }];
    const index = {
      start: 900,
      networkErrors: [{ t: 1000, id: "r1", method, url }],
    };
    return buildEvidenceCandidates(events, index).find(
      (c) => c.detector === "network_error",
    );
  }

  it("drops the query string from the title and keeps it short", () => {
    const candidate = candidateFor(analyticsUrl);

    expect(candidate?.title).toBe(
      "Network error from POST https://www.google.com/g/collect",
    );
    expect(candidate?.title).not.toContain("REDACTED");
    expect(candidate?.title.length).toBeLessThanOrEqual(160);
  });

  it("keeps the full redacted URL on the anchor", () => {
    const candidate = candidateFor(analyticsUrl);

    expect(candidate?.anchor?.url).toContain("/g/collect?");
    expect(candidate?.anchor?.url).toContain("REDACTED");
  });

  it("drops a fragment as well", () => {
    const candidate = candidateFor("https://app.example/api/pay#section-2");

    expect(candidate?.title).toBe(
      "Network error from POST https://app.example/api/pay",
    );
  });

  it("says so plainly when the URL is missing", () => {
    const candidate = candidateFor("", "GET");

    expect(candidate?.title).toBe("Network error from GET unknown URL");
  });
});

// Titles are read by a human scanning a queue, so a placeholder that leaked
// from a missing field ("undefined", "**********") is a defect, not a detail.
describe("candidate titles — no leaked placeholders", () => {
  it("names the missing URL on an http_error rather than printing undefined", () => {
    const index = {
      start: 900,
      failedReqs: [{ t: 1000, st: 500, id: "req-1" }],
    };

    const candidate = buildEvidenceCandidates(
      [{ t: 1000, k: "net.res", d: { id: "req-1", st: 500 } }],
      index,
    ).find((c) => c.detector === "http_error");

    expect(candidate?.title).toBe("HTTP 500 from request unknown URL");
    expect(candidate?.title).not.toContain("undefined");
  });

  // A failing response whose `net.req` did not survive the retained window used
  // to be indexed as `{m:"", url:""}`, and every reader downstream — the agent
  // brief's timeline, the cloud's representative, the diagnosis — was left with
  // "request → 500" while the backend record for the same correlated request
  // named the endpoint outright. The response carries its own identity now; the
  // backend record is the fallback for a session captured before it did.
  it("names the endpoint from the backend record when the frontend request is gone", () => {
    const index = {
      start: 900,
      failedReqs: [{ t: 1000, m: "", url: "", st: 500, requestId: "corr-1" }],
    };

    const candidate = buildEvidenceCandidates(
      [
        { t: 1000, k: "net.res", d: { id: 7, st: 500, requestId: "corr-1" } },
        {
          t: 995,
          k: "backend.req.error",
          d: {
            requestId: "corr-1",
            method: "GET",
            pathname: "/api/marginary/events",
            statusCode: 500,
            error: { name: "Error", message: "api exploded" },
          },
        },
      ],
      index,
    ).find((c) => c.detector === "http_error");

    expect(candidate?.title).toBe("HTTP 500 from GET /api/marginary/events");
    expect(candidate?.anchor?.method).toBe("GET");
    expect(candidate?.anchor?.url).toBe("/api/marginary/events");
  });

  it("prefers the frontend's own URL over the backend record", () => {
    const index = {
      start: 900,
      failedReqs: [
        {
          t: 1000,
          m: "GET",
          url: "https://app.example/api/orders?limit=200",
          st: 500,
          requestId: "corr-2",
        },
      ],
    };

    const candidate = buildEvidenceCandidates(
      [
        { t: 1000, k: "net.res", d: { id: 7, st: 500, requestId: "corr-2" } },
        {
          t: 995,
          k: "backend.req.start",
          d: { requestId: "corr-2", method: "GET", pathname: "/orders" },
        },
      ],
      index,
    ).find((c) => c.detector === "http_error");

    expect(candidate?.title).toBe(
      "HTTP 500 from GET https://app.example/api/orders",
    );
    expect(candidate?.anchor?.url).toContain("limit=");
  });

  it("names the missing URL on a slow_request rather than printing undefined", () => {
    const candidate = buildEvidenceCandidates(
      [{ t: 1000, k: "net.res", d: { id: "no-such-request", dur: 9_000 } }],
      { start: 900 },
    ).find((c) => c.detector === "slow_request");

    expect(candidate?.title).toBe("Slow request unknown URL");
    expect(candidate?.title).not.toContain("undefined");
  });

  it("falls back to the element role when the click label is fully masked", () => {
    const clicks = [1000, 1500, 2000].map((t) => ({
      t,
      k: "clk" as const,
      d: {
        target: { label: "sk-ABCD1234ABCD1234ABCD1234", role: "button" },
      },
    }));

    const candidate = buildEvidenceCandidates(clicks, { start: 900 }).find(
      (c) => c.detector === "repeated_clicks",
    );

    expect(candidate?.title).toBe("Repeated clicks on a button");
  });

  it("falls back to a plain phrase when a click has no usable identity", () => {
    const clicks = [1000, 1500, 2000].map((t) => ({
      t,
      k: "clk" as const,
      d: {},
    }));

    const candidate = buildEvidenceCandidates(clicks, { start: 900 }).find(
      (c) => c.detector === "repeated_clicks",
    );

    expect(candidate?.title).toBe("Repeated clicks on an unlabeled element");
  });
});
