import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

describe("buildEvidenceCandidates — backend errors", () => {
  it("surfaces a backend.req.error as a high-severity candidate (score 90)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.req.error",
        d: {
          requestId: "req-1",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          error: {
            name: "TypeError",
            message:
              "Cannot read properties of undefined (reading 'amount_cents')",
          },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "backend_request_error");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(90);
    expect(cand!.anchor.requestId).toBe("req-1");
    expect(cand!.anchor.status).toBe(500);
    expect(cand!.anchor.route).toBe("/api/checkout");
    expect(cand!.anchor.errorCode).toBe("TypeError");
    expect(cand!.anchor.message).toContain("amount_cents");
  });

  it("surfaces a backend.req.end 500 (no thrown error object) as high-severity (score 89)", () => {
    const events: BugEvent[] = [
      {
        t: 2000,
        k: "backend.req.end",
        d: {
          requestId: "req-2",
          method: "GET",
          route: "/api/search",
          statusCode: 500,
          durationMs: 12,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 2000 });
    const cand = candidates.find((c) => c.detector === "backend_http_error");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(89);
    expect(cand!.anchor.status).toBe(500);
  });

  it("surfaces a backend.req.end 4xx as a medium-severity client error (score 66)", () => {
    const events: BugEvent[] = [
      {
        t: 3000,
        k: "backend.req.end",
        d: {
          requestId: "req-3",
          method: "POST",
          route: "/api/cart/items",
          statusCode: 409,
          durationMs: 5,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 3000 });
    const cand = candidates.find(
      (c) => c.detector === "backend_http_client_error",
    );
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("medium");
    expect(cand!.score).toBe(66);
    expect(cand!.anchor.status).toBe(409);
  });

  it("does not surface a backend.req.end below 400", () => {
    const events: BugEvent[] = [
      {
        t: 4000,
        k: "backend.req.end",
        d: {
          requestId: "req-4",
          method: "GET",
          route: "/api/products",
          statusCode: 200,
          durationMs: 8,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 4000 });
    expect(
      candidates.find((c) => c.detector?.startsWith("backend_")),
    ).toBeUndefined();
  });

  it("collapses a request that emits both backend.req.error and backend.req.end into one candidate (the error wins)", () => {
    const events: BugEvent[] = [
      {
        t: 5000,
        k: "backend.req.end",
        d: {
          requestId: "req-5",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          durationMs: 20,
        },
      },
      {
        t: 5000,
        k: "backend.req.error",
        d: {
          requestId: "req-5",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          error: { name: "TypeError", message: "boom" },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 5000 });
    const backendCands = candidates.filter((c) =>
      c.detector?.startsWith("backend_"),
    );
    expect(backendCands.length).toBe(1);
    expect(backendCands[0].detector).toBe("backend_request_error");
    expect(backendCands[0].score).toBe(90);
  });

  it("collapses a thrown error (no statusCode) plus a 500 end for the same request into one candidate", () => {
    // Realistic shape: the error event carries no statusCode (thrown before the response is
    // finalized), while the response's end event carries 500. Both must collapse on requestId.
    const events: BugEvent[] = [
      {
        t: 6000,
        k: "backend.req.error",
        d: {
          requestId: "req-6",
          method: "POST",
          route: "/api/checkout",
          error: { name: "TypeError", message: "boom" },
        },
      },
      {
        t: 6010,
        k: "backend.req.end",
        d: {
          requestId: "req-6",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          durationMs: 20,
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 6000 });
    const backendCands = candidates.filter((c) =>
      c.detector?.startsWith("backend_"),
    );
    expect(backendCands.length).toBe(1);
    expect(backendCands[0].detector).toBe("backend_request_error");
    expect(backendCands[0].score).toBe(90);
  });
});

describe("buildEvidenceCandidates — console warnings", () => {
  it("surfaces a console.warn as a low-severity candidate (score 50)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "con",
        d: { lv: "warn", msg: "Total mismatch: 233.74000000000004 vs 233.74" },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "console_warning");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("low");
    expect(cand!.score).toBe(50);
    expect(cand!.confidence).toBe("low");
    expect(cand!.anchor.message).toContain("Total mismatch");
  });

  it("does not surface console.warn as an error and does not surface console.log", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "log", msg: "just info" } },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.find((c) => c.detector === "console_warning"),
    ).toBeUndefined();
  });

  it("collapses a warning that re-fires every render into one candidate (earliest anchor)", () => {
    const msg =
      'Warning: Each child in a list should have a unique "key" prop.';
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "warn", msg } },
      { t: 1200, k: "con", d: { lv: "warn", msg } },
      { t: 1400, k: "con", d: { lv: "warn", msg } },
      { t: 1600, k: "con", d: { lv: "warn", msg } },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const warnings = candidates.filter((c) => c.detector === "console_warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].anchor.t).toBe(1000);
  });
});

describe("buildEvidenceCandidates — backend crash titles", () => {
  function uncaught(t: number, error: Record<string, unknown>): BugEvent {
    return { t, k: "backend.uncaught", d: { error } };
  }

  it("gives two unrelated request-less crashes two different titles", () => {
    const events: BugEvent[] = [
      uncaught(1000, {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'seatPolicy')",
        stack: "at auth.js:41:12",
      }),
      uncaught(2000, {
        name: "Error",
        message: "deliberate probe failure",
        stack: "at meta.js:12:3",
      }),
    ];
    const titles = buildEvidenceCandidates(events, { start: 1000 })
      .filter((c) => c.detector === "backend_request_error")
      .map((c) => c.title);
    expect(titles.length).toBe(2);
    expect(new Set(titles).size).toBe(2);
    expect(titles.some((title) => title.includes("seatPolicy"))).toBe(true);
    expect(titles.some((title) => title.includes("probe failure"))).toBe(true);
    expect(titles).not.toContain("Backend error from request");
  });

  it("titles the same crash identically on every run", () => {
    const crash = () =>
      buildEvidenceCandidates(
        [uncaught(1000, { name: "TypeError", message: "boom" })],
        {
          start: 1000,
        },
      )[0].title;
    expect(crash()).toBe(crash());
    expect(crash()).toBe("Backend TypeError: boom");
  });

  it("falls back to the message when the error carries no class", () => {
    const [cand] = buildEvidenceCandidates(
      [uncaught(1000, { message: "connection terminated unexpectedly" })],
      { start: 1000 },
    );
    expect(cand.title).toBe(
      "Backend error: connection terminated unexpectedly",
    );
  });

  it("keeps the endpoint form when a route is known, and names what the error said", () => {
    const [cand] = buildEvidenceCandidates(
      [
        {
          t: 1000,
          k: "backend.req.error",
          d: {
            requestId: "req-1",
            method: "POST",
            pathname: "/api/checkout",
            statusCode: 500,
            error: { name: "TypeError", message: "boom" },
          },
        },
      ],
      { start: 1000 },
    );
    // The message, not the class: the route already names the endpoint, so the
    // suffix exists to separate one way it fails from another, and "boom"
    // separates more of them than "TypeError" does. The class stays on the
    // anchor, and is still the suffix when the error carried no message.
    expect(cand.title).toBe("Backend HTTP 500 from POST /api/checkout: boom");
  });

  it("names the error class when the error carried no message", () => {
    const [cand] = buildEvidenceCandidates(
      [
        {
          t: 1000,
          k: "backend.req.error",
          d: {
            requestId: "req-1",
            method: "POST",
            pathname: "/api/checkout",
            statusCode: 500,
            error: { name: "TypeError" },
          },
        },
      ],
      { start: 1000 },
    );
    expect(cand.title).toBe(
      "Backend HTTP 500 from POST /api/checkout: TypeError",
    );
  });

  it("keeps the query string out of a backend title but on the anchor", () => {
    const [cand] = buildEvidenceCandidates(
      [
        {
          t: 1000,
          k: "backend.req.end",
          d: {
            requestId: "req-2",
            method: "GET",
            pathname: "/v2/search?q=shoes",
            statusCode: 404,
          },
        },
      ],
      { start: 1000 },
    );
    expect(cand.title).toBe("Backend HTTP 404 from GET /v2/search");
    expect(cand.anchor.url).toContain("/v2/search?q=");
  });

  it("bounds a long message so a title stays a headline", () => {
    const [cand] = buildEvidenceCandidates(
      [
        uncaught(1000, {
          name: "Error",
          message: `pool timeout ${"and again ".repeat(60)}`,
        }),
      ],
      { start: 1000 },
    );
    expect(cand.title.startsWith("Backend Error: pool timeout")).toBe(true);
    expect(cand.title.length).toBeLessThanOrEqual(140);
  });

  it("keeps a stack out of the title when the message carries its own frames", () => {
    const [cand] = buildEvidenceCandidates(
      [
        uncaught(1000, {
          name: "Error",
          message:
            "Error: api exploded\n    at /private/tmp/app/index.js:38:40\n    at Layer.handle [as handle_request] (/private/tmp/app/node_modules/express/lib/router/layer.js:95:5)",
        }),
      ],
      { start: 1000 },
    );
    expect(cand.title).toBe("Backend Error: api exploded");
    expect(cand.anchor.message).toContain("index.js:38:40");
  });

  it("keeps a stack out of the title when the frames arrive on one line", () => {
    // The shape the collapse produces before this ever runs: `safeText` turns
    // every newline into a space, so a newline split alone is not a defence.
    const [cand] = buildEvidenceCandidates(
      [
        uncaught(1000, {
          name: "TypeError",
          message:
            "cannot read properties of undefined (reading 'total')    at /srv/app/cart.js:12:7    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)",
        }),
      ],
      { start: 1000 },
    );
    expect(cand.title).toBe(
      "Backend TypeError: cannot read properties of undefined (reading 'total')",
    );
  });

  it("keeps prose that merely contains the word at", () => {
    const [cand] = buildEvidenceCandidates(
      [uncaught(1000, { name: "Error", message: "checkout failed at step 2" })],
      { start: 1000 },
    );
    expect(cand.title).toBe("Backend Error: checkout failed at step 2");
  });

  it("names the request a request-less crash happened inside", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 900,
          k: "backend.req.start",
          d: {
            requestId: "req-9",
            method: "POST",
            pathname: "/api/orders",
            route: "/api/orders",
          },
        },
        uncaught(1000, { name: "Error", message: "api exploded" }),
        {
          t: 1100,
          k: "backend.req.end",
          d: { requestId: "req-9", method: "POST", statusCode: 500 },
        },
      ],
      { start: 900 },
    );
    const cand = candidates.find(
      (c) => c.detector === "backend_request_error",
    )!;
    expect(cand.anchor.route).toBe("/api/orders");
    expect(cand.anchor.method).toBe("POST");
    expect(cand.anchor.status).toBe(500);
    expect(cand.anchor.requestId).toBe("req-9");
    expect(cand.title).toBe(
      "Backend HTTP 500 from POST /api/orders: api exploded",
    );
  });

  it("leaves a crash request-less when two requests were open at once", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 900,
          k: "backend.req.start",
          d: { requestId: "req-a", method: "POST", pathname: "/api/orders" },
        },
        {
          t: 950,
          k: "backend.req.start",
          d: { requestId: "req-b", method: "GET", pathname: "/api/me" },
        },
        uncaught(1000, { name: "Error", message: "api exploded" }),
      ],
      { start: 900 },
    );
    const cand = candidates.find(
      (c) => c.detector === "backend_request_error",
    )!;
    expect(cand.anchor.route).toBeUndefined();
    expect(cand.anchor.method).toBeUndefined();
    expect(cand.title).toBe("Backend Error: api exploded");
  });
});

describe("buildEvidenceCandidates — backend error status honesty", () => {
  const boom = { name: "TypeError", message: "boom" };

  function backendError(t: number, d: Record<string, unknown>): BugEvent {
    return { t, k: "backend.req.error", d };
  }

  it("never asserts the default 200 the error middleware read mid-request", () => {
    const [cand] = buildEvidenceCandidates(
      [
        backendError(1000, {
          requestId: "req-1",
          method: "POST",
          pathname: "/api/checkout",
          statusCode: 200,
          error: boom,
        }),
      ],
      { start: 1000 },
    );
    expect(cand.title).toBe("Backend error from POST /api/checkout: boom");
    expect(cand.title).not.toContain("200");
    expect(cand.anchor.status).toBeUndefined();
  });

  it("uses the status the request finished with, not the one read at error time", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 900,
          k: "backend.req.start",
          d: { requestId: "req-1", method: "POST", pathname: "/api/checkout" },
        },
        backendError(1000, {
          requestId: "req-1",
          method: "POST",
          pathname: "/api/checkout",
          statusCode: 200,
          error: boom,
        }),
        {
          t: 1100,
          k: "backend.req.end",
          d: { requestId: "req-1", method: "POST", statusCode: 500 },
        },
      ],
      { start: 900 },
    );
    const cand = candidates.find(
      (c) => c.detector === "backend_request_error",
    )!;
    expect(cand.anchor.status).toBe(500);
    expect(cand.title).toBe("Backend HTTP 500 from POST /api/checkout: boom");
  });

  it("keeps a failure status the error itself declared", () => {
    const [cand] = buildEvidenceCandidates(
      [
        backendError(1000, {
          requestId: "req-1",
          method: "GET",
          pathname: "/api/orders",
          statusCode: 200,
          error: { name: "HttpError", message: "not found", statusCode: 404 },
        }),
      ],
      { start: 1000 },
    );
    expect(cand.anchor.status).toBe(404);
    expect(cand.title).toContain("HTTP 404");
  });

  it("does not let an error-time 200 mark a crash's enclosing request successful", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 900,
          k: "backend.req.start",
          d: { requestId: "req-1", method: "POST", pathname: "/api/orders" },
        },
        backendError(950, {
          requestId: "req-1",
          statusCode: 200,
          error: boom,
        }),
        { t: 1000, k: "backend.uncaught", d: { error: boom } },
        {
          t: 1100,
          k: "backend.req.end",
          d: { requestId: "req-1", method: "POST", statusCode: 500 },
        },
      ],
      { start: 900 },
    );
    for (const cand of candidates.filter(
      (c) => c.detector === "backend_request_error",
    ))
      expect(cand.anchor.status).not.toBe(200);
  });
});

describe("buildEvidenceCandidates — backend console.error tiering", () => {
  function consoleError(error: Record<string, unknown>): BugEvent {
    return {
      t: 1000,
      k: "backend.uncaught",
      d: { source: "console.error", error },
    };
  }

  function candidate(event: BugEvent) {
    return buildEvidenceCandidates([event], { start: 1000 }).find(
      (c) => c.detector === "backend_request_error",
    )!;
  }

  it("keeps a console.error that logged a real Error at the top tier", () => {
    const cand = candidate(
      consoleError({
        name: "TypeError",
        message: "cannot read properties of undefined",
        stack: "TypeError: boom\n    at cart.js:12:7",
      }),
    );
    expect(cand.severity).toBe("high");
    expect(cand.score).toBe(90);
  });

  it("keeps a bare console.error that names a fault high", () => {
    const cand = candidate({
      t: 1000,
      k: "backend.uncaught",
      d: {
        source: "console.error",
        error: {
          name: "Error",
          message: "payment capture failed for order 12",
        },
      },
    });
    expect(cand.severity).toBe("high");
  });

  it("does not make an informational console.error an automatic high", () => {
    const cand = candidate(
      consoleError({ name: "Error", message: "retrying upstream in 200ms" }),
    );
    expect(cand.severity).toBe("medium");
    expect(cand.score).toBeLessThan(90);
    expect(cand.confidence).toBe("medium");
  });

  it("ranks a handled console.error below the fault that broke the request", () => {
    const candidates = buildEvidenceCandidates(
      [
        {
          t: 900,
          k: "backend.uncaught",
          d: {
            source: "console.error",
            error: { name: "Error", message: "cache warm skipped" },
          },
        },
        {
          t: 1000,
          k: "backend.req.error",
          d: {
            requestId: "req-1",
            method: "POST",
            pathname: "/api/checkout",
            statusCode: 500,
            error: { name: "TypeError", message: "boom" },
          },
        },
      ],
      { start: 900 },
    );
    const notice = candidates.find((c) => c.title.includes("cache warm"))!;
    const fault = candidates.find((c) => c.title.includes("boom"))!;
    expect(notice.score).toBeLessThan(fault.score);
  });

  it("leaves a real uncaught exception high whatever it says", () => {
    const cand = candidate({
      t: 1000,
      k: "backend.uncaught",
      d: {
        source: "uncaughtException",
        error: { name: "Error", message: "shutting down" },
      },
    });
    expect(cand.severity).toBe("high");
    expect(cand.score).toBe(90);
  });
});

describe("buildEvidenceCandidates — backend frame from a raw stack", () => {
  it("anchors a console.error'd Error by its stack when no structured frames exist", () => {
    const events: BugEvent[] = [
      {
        t: 4000,
        k: "backend.uncaught",
        d: {
          source: "console.error",
          error: {
            name: "TypeError",
            message: "tick blew up",
            stack:
              "TypeError: tick blew up\n" +
              "    at process (node:internal/timers:12:9)\n" +
              "    at retry (/app/node_modules/p-retry/index.js:40:5)\n" +
              "    at tick (/app/src/worker.ts:152:17)",
          },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 4000 });
    const cand = candidates.find((c) => c.detector === "backend_request_error");
    expect(cand).toBeDefined();
    expect(cand!.anchor.frame).toBe("/app/src/worker.ts:152:17");
  });
});
