import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  buildCausalGraph,
  CAUSAL_GRAPH_SCHEMA_VERSION,
  type CausalEdge,
  type CausalGraph,
  type CausalNodeKind,
} from "../causal-graph";

function kinds(graph: CausalGraph): Set<CausalNodeKind> {
  return new Set(graph.nodes.map((n) => n.kind));
}

function edgeBetween(
  graph: CausalGraph,
  fromKind: CausalNodeKind,
  toKind: CausalNodeKind,
  edgeKind: CausalEdge["kind"],
): CausalEdge | undefined {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges.find((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return (
      from?.kind === fromKind && to?.kind === toKind && e.kind === edgeKind
    );
  });
}

describe("buildCausalGraph — node-kind mapping", () => {
  it("maps every supported event kind to its node kind", () => {
    const events: BugEvent[] = [
      { t: 100, k: "clk", d: {} },
      { t: 200, k: "inp", d: {} },
      { t: 300, k: "nav", d: { to: "https://app.test/home" } },
      {
        t: 400,
        k: "net.req",
        d: { id: "n1", url: "https://api.test/x", m: "GET" },
      },
      { t: 500, k: "net.res", d: { id: "n1", st: 200 } },
      { t: 600, k: "backend.req.start", d: { requestId: "req1", route: "/x" } },
      { t: 700, k: "backend.req.end", d: { requestId: "req1", route: "/x" } },
      {
        t: 800,
        k: "backend.req.error",
        d: { requestId: "req2", message: "boom" },
      },
      {
        t: 900,
        k: "db.diff",
        d: { requestId: "req1", op: "insert", table: "users" },
      },
      {
        t: 1000,
        k: "backend.otel.span",
        d: { requestId: "trace1", spanId: "s1", name: "GET /x" },
      },
      {
        t: 1100,
        k: "backend.otel.log",
        d: { requestId: "trace1", spanId: "s2", severityText: "ERROR" },
      },
      { t: 1200, k: "err", d: { msg: "TypeError" } },
      { t: 1300, k: "rej", d: { msg: "unhandled" } },
      { t: 1400, k: "con", d: { lv: "error", msg: "console boom" } },
    ];
    const graph = buildCausalGraph({ events });
    const seen = kinds(graph);
    for (const expected of [
      "user.click",
      "user.input",
      "user.nav",
      "net.req",
      "net.res",
      "backend.req",
      "backend.error",
      "db.write",
      "otel.span",
      "otel.log",
      "frontend.error",
      "console.error",
    ] as CausalNodeKind[]) {
      expect(seen.has(expected)).toBe(true);
    }
  });

  it("sets the schema version constant", () => {
    const graph = buildCausalGraph({ events: [] });
    expect(graph.schemaVersion).toBe(CAUSAL_GRAPH_SCHEMA_VERSION);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("ignores non-error console events (con with info level)", () => {
    const graph = buildCausalGraph({
      events: [{ t: 1, k: "con", d: { lv: "info", msg: "hi" } }],
    });
    expect(graph.nodes).toHaveLength(0);
  });

  it("never places raw URLs in node fields", () => {
    const graph = buildCausalGraph({
      events: [
        {
          t: 1,
          k: "net.req",
          d: {
            id: "n1",
            url: "https://api.test/users/1234567890abcdefghij?token=secret",
            m: "GET",
          },
        },
      ],
    });
    const node = graph.nodes.find((n) => n.kind === "net.req")!;
    expect(node.sig ?? "").not.toContain("secret");
    expect(node.brief).not.toContain("secret");
  });

  it("derives otel.log sig/brief from severityText/body (not span-only name/statusMessage), redacted", () => {
    // Real OTLP log events carry severityText/body — name/statusMessage are SPAN fields, so the old
    // sigFor returned undefined on logs. The sig/brief must now come from the log's own fields and
    // still be REDACTED (token-like content stripped).
    const graph = buildCausalGraph({
      events: [
        {
          t: 1,
          k: "backend.otel.log",
          d: {
            requestId: "trace1",
            spanId: "s1",
            severityText: "ERROR",
            body: "checkout failed token=sk_fake_abcdefghijklmnop",
          },
        },
      ],
    });
    const node = graph.nodes.find((n) => n.kind === "otel.log")!;
    expect(node.sig).toBeDefined();
    // severityText is preferred as the sig source.
    expect(node.sig).toBe("ERROR");
    expect(node.brief).toContain("log");
    expect(node.brief).toContain("ERROR");
    // Redaction is preserved: no raw secret leaks via sig or brief.
    expect(node.sig ?? "").not.toContain("sk_fake_abcdefghijklmnop");
    expect(node.brief).not.toContain("sk_fake_abcdefghijklmnop");
  });

  it("falls back to the redacted log body for otel.log sig when severityText is absent", () => {
    const graph = buildCausalGraph({
      events: [
        {
          t: 1,
          k: "backend.otel.log",
          d: {
            requestId: "trace1",
            spanId: "s1",
            body: "db write failed token=sk_fake_abcdefghijklmnopqrstuvwx1234",
          },
        },
      ],
    });
    const node = graph.nodes.find((n) => n.kind === "otel.log")!;
    expect(node.sig).toBeDefined();
    // body is the sig source when severityText is absent, still passed through safeDiagnosticString.
    expect(node.sig ?? "").toContain("db write failed");
    expect(node.sig ?? "").not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwx1234",
    );
    expect(node.brief).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx1234");
  });
});

describe("buildCausalGraph — request edge rule", () => {
  it("connects the Express-500 spine and a symptom edge to the frontend error", () => {
    const events: BugEvent[] = [
      {
        t: 100,
        k: "net.req",
        d: {
          id: "n1",
          requestId: "req1",
          url: "https://api.test/checkout",
          m: "POST",
        },
      },
      {
        t: 150,
        k: "backend.req.start",
        d: { requestId: "req1", route: "/checkout" },
      },
      {
        t: 200,
        k: "backend.req.error",
        d: { requestId: "req1", message: "db failed" },
      },
      { t: 250, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
      { t: 300, k: "err", d: { msg: "Request failed" } },
    ];
    const graph = buildCausalGraph({ events });

    // request spine edges
    expect(
      edgeBetween(graph, "net.req", "backend.req", "request"),
    ).toBeDefined();
    expect(
      edgeBetween(graph, "backend.req", "backend.error", "request"),
    ).toBeDefined();
    expect(
      edgeBetween(graph, "backend.error", "net.res", "request"),
    ).toBeDefined();

    // symptom edge from the failed net.res (or backend.error) to the frontend error
    const symptom = graph.edges.filter((e) => e.kind === "symptom");
    expect(symptom.length).toBeGreaterThan(0);
    expect(
      edgeBetween(graph, "net.res", "frontend.error", "symptom"),
    ).toBeDefined();
  });

  it("connects db.write into the request spine", () => {
    const events: BugEvent[] = [
      {
        t: 100,
        k: "net.req",
        d: {
          id: "n1",
          requestId: "req1",
          url: "https://api.test/x",
          m: "POST",
        },
      },
      { t: 150, k: "backend.req.start", d: { requestId: "req1", route: "/x" } },
      {
        t: 175,
        k: "db.diff",
        d: { requestId: "req1", op: "update", table: "orders" },
      },
      { t: 200, k: "backend.req.end", d: { requestId: "req1", route: "/x" } },
      { t: 250, k: "net.res", d: { id: "n1", requestId: "req1", st: 200 } },
    ];
    const graph = buildCausalGraph({ events });
    expect(
      edgeBetween(graph, "backend.req", "db.write", "request"),
    ).toBeDefined();
    expect(
      edgeBetween(graph, "db.write", "backend.req", "request"),
    ).toBeDefined();
  });
});

describe("buildCausalGraph — OTLP traceId bridge", () => {
  it("makes the span a request-edge root reachable from net.req and links span→log", () => {
    const events: BugEvent[] = [
      {
        t: 100,
        k: "net.req",
        d: {
          id: "n1",
          requestId: "trace1",
          url: "https://api.test/x",
          m: "GET",
        },
      },
      {
        t: 150,
        k: "backend.otel.span",
        d: { requestId: "trace1", spanId: "s1", name: "GET /x" },
      },
      {
        t: 200,
        k: "backend.otel.log",
        d: { requestId: "trace1", spanId: "s2", severityText: "ERROR" },
      },
    ];
    const graph = buildCausalGraph({ events });
    expect(edgeBetween(graph, "net.req", "otel.span", "request")).toBeDefined();
    expect(
      edgeBetween(graph, "otel.span", "otel.log", "request"),
    ).toBeDefined();
  });
});

describe("buildCausalGraph — interaction edge banding", () => {
  function interactionConf(
    deltaMs: number,
    sameRoute: boolean,
  ): CausalEdge | undefined {
    const events: BugEvent[] = [
      { t: 1000, k: "clk", d: { route: sameRoute ? "/checkout" : "/other" } },
      {
        t: 1000 + deltaMs,
        k: "net.req",
        d: {
          id: "n1",
          url: "https://api.test/x",
          m: "GET",
          route: "/checkout",
        },
      },
    ];
    const graph = buildCausalGraph({ events });
    return graph.edges.find((e) => e.kind === "interaction");
  }

  it("high at 300ms with same route", () => {
    expect(interactionConf(300, true)?.confidence).toBe("high");
  });

  it("medium at 700ms (over 500ms)", () => {
    expect(interactionConf(700, true)?.confidence).toBe("medium");
  });

  it("medium at 300ms when route differs (context mismatch downgrades)", () => {
    expect(interactionConf(300, false)?.confidence).toBe("medium");
  });

  it("none at 2500ms (outside window)", () => {
    expect(interactionConf(2500, true)).toBeUndefined();
  });

  it("exactly 500ms is high", () => {
    expect(interactionConf(500, true)?.confidence).toBe("high");
  });

  it("exactly 2000ms is present (medium)", () => {
    expect(interactionConf(2000, true)?.confidence).toBe("medium");
  });
});

describe("buildCausalGraph — symptom edge banding", () => {
  function symptomConf(deltaMs: number): CausalEdge | undefined {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "net.req",
        d: { id: "n1", requestId: "req1", url: "https://api.test/x", m: "GET" },
      },
      { t: 1000, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
      { t: 1000 + deltaMs, k: "err", d: { msg: "boom" } },
    ];
    const graph = buildCausalGraph({ events });
    return graph.edges.find((e) => e.kind === "symptom");
  }

  it("high at 400ms", () => {
    expect(symptomConf(400)?.confidence).toBe("high");
  });

  it("medium at 1500ms", () => {
    expect(symptomConf(1500)?.confidence).toBe("medium");
  });

  it("none at 2500ms", () => {
    expect(symptomConf(2500)).toBeUndefined();
  });

  it("exactly 500ms is high", () => {
    expect(symptomConf(500)?.confidence).toBe("high");
  });
});

describe("buildCausalGraph — temporal fallback", () => {
  it("fires for a lone err after a nav with no stronger key", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "nav", d: { to: "https://app.test/x" } },
      { t: 1200, k: "err", d: { msg: "boom" } },
    ];
    const graph = buildCausalGraph({ events });
    const temporal = graph.edges.filter((e) => e.kind === "temporal");
    expect(temporal).toHaveLength(1);
    expect(temporal[0].confidence).toBe("low");
    expect(
      edgeBetween(graph, "user.nav", "frontend.error", "temporal"),
    ).toBeDefined();
  });

  it("does NOT fire when a stronger symptom edge covers the error node", () => {
    const events: BugEvent[] = [
      { t: 900, k: "nav", d: { to: "https://app.test/x" } },
      {
        t: 1000,
        k: "net.req",
        d: { id: "n1", requestId: "req1", url: "https://api.test/x", m: "GET" },
      },
      { t: 1000, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
      { t: 1100, k: "err", d: { msg: "boom" } },
    ];
    const graph = buildCausalGraph({ events });
    // the error node has a symptom edge; no temporal edge should target it
    const errNode = graph.nodes.find((n) => n.kind === "frontend.error")!;
    const temporalToErr = graph.edges.filter(
      (e) => e.kind === "temporal" && e.to === errNode.id,
    );
    expect(temporalToErr).toHaveLength(0);
    expect(
      graph.edges.some((e) => e.kind === "symptom" && e.to === errNode.id),
    ).toBe(true);
  });
});

describe("buildCausalGraph — determinism", () => {
  const events: BugEvent[] = [
    { t: 100, k: "clk", d: { route: "/checkout" } },
    {
      t: 150,
      k: "net.req",
      d: {
        id: "n1",
        requestId: "req1",
        url: "https://api.test/checkout",
        m: "POST",
        route: "/checkout",
      },
    },
    {
      t: 200,
      k: "backend.req.start",
      d: { requestId: "req1", route: "/checkout" },
    },
    {
      t: 250,
      k: "db.diff",
      d: { requestId: "req1", op: "insert", table: "orders" },
    },
    {
      t: 300,
      k: "backend.req.error",
      d: { requestId: "req1", message: "db failed" },
    },
    { t: 350, k: "net.res", d: { id: "n1", requestId: "req1", st: 500 } },
    { t: 400, k: "err", d: { msg: "Request failed" } },
    { t: 500, k: "con", d: { lv: "error", msg: "unhandled" } },
  ];

  it("produces byte-identical output across two builds", () => {
    const a = JSON.stringify(buildCausalGraph({ events }));
    const b = JSON.stringify(buildCausalGraph({ events }));
    expect(a).toBe(b);
  });

  it("is invariant to input order (shuffle) — proves index-free ids", () => {
    const canonical = JSON.stringify(buildCausalGraph({ events }));
    // deterministic reversal + rotation shuffles (no randomness in the test)
    const reversed = [...events].reverse();
    const rotated = [...events.slice(3), ...events.slice(0, 3)];
    expect(JSON.stringify(buildCausalGraph({ events: reversed }))).toBe(
      canonical,
    );
    expect(JSON.stringify(buildCausalGraph({ events: rotated }))).toBe(
      canonical,
    );
  });

  it("does not mutate the input array", () => {
    const snapshot = JSON.stringify(events);
    buildCausalGraph({ events });
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
