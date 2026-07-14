import { describe, expect, it } from "vitest";
import type { SessionComparison } from "../compare/index";
import {
  formatComparisonSummary,
  renderCompareReport,
} from "../compare/report";

export const REGRESSION_FIXTURE: SessionComparison = {
  schemaVersion: "session-compare.v1",
  verdict: "regression",
  confidence: "high",
  a: { sessionId: "ses_base_001" },
  b: { sessionId: "ses_head_002" },
  alignment: { matchedSteps: 12, unmatchedA: 0, unmatchedB: 1 },
  divergences: [
    {
      plane: "db",
      kind: "db.row-value",
      sig: "main>form#checkout>button[type=submit]",
      requestId: "req_9f3a",
      table: "orders",
      pk: { id: 41 },
      before: { total_cents: 4200 },
      after: { total_cents: 100 },
      brief:
        "orders row id=41: total_cents 4200 -> 100 after the same recorded checkout click",
    },
    {
      plane: "network",
      kind: "net.status",
      sig: "main>form#checkout>button[type=submit]",
      requestId: "req_9f3a",
      before: 200,
      after: 500,
      brief: "POST /api/orders returned 500 on B (200 on A)",
    },
    {
      plane: "flow",
      kind: "flow.step-missing",
      sig: "main>div.confirmation>h2",
      before: "confirmation heading rendered",
      after: "step absent",
      brief: "confirmation heading never rendered on B",
    },
  ],
  noise: { suppressedCount: 7, rules: ["timestamp-fields", "generated-ids"] },
  evidence: [],
  intent: [],
};

export const CLEAN_FIXTURE: SessionComparison = {
  schemaVersion: "session-compare.v1",
  verdict: "clean",
  confidence: "high",
  a: { sessionId: "ses_base_001" },
  b: { sessionId: "ses_head_003" },
  alignment: { matchedSteps: 13, unmatchedA: 0, unmatchedB: 0 },
  divergences: [],
  noise: { suppressedCount: 9, rules: ["timestamp-fields", "generated-ids"] },
  evidence: [],
  intent: [],
};

describe("renderCompareReport", () => {
  it("renders a regression verdict banner, aligned-flow table, per-plane sections, and noise footnote", () => {
    const report = renderCompareReport(REGRESSION_FIXTURE);
    expect(report).toContain(
      "# Session comparison - ses_base_001 vs ses_head_002",
    );
    expect(report).toContain("**Verdict: REGRESSION** (confidence: high)");
    expect(report).toContain(
      "12 step(s) matched by component identity · 0 only in A · 1 only in B",
    );
    expect(report).toContain("| Plane | Kind | Component | Divergence |");
    expect(report).toContain("| **db** | `db.row-value` |");
    expect(report).toContain("| **flow** | `flow.step-missing` |");
    const flowIdx = report.indexOf("## Flow steps");
    const netIdx = report.indexOf("## Network calls");
    const dbIdx = report.indexOf("## Database rows");
    expect(flowIdx).toBeGreaterThan(-1);
    expect(netIdx).toBeGreaterThan(flowIdx);
    expect(dbIdx).toBeGreaterThan(netIdx);
    expect(report).toContain('- before: {"total_cents":4200}');
    expect(report).toContain('+ after:  {"total_cents":100}');
    expect(report).toContain('- Table: `orders` · pk `{"id":41}`');
    expect(report).toContain(
      "7 expected-variance difference(s) suppressed by the noise model (timestamp-fields, generated-ids)",
    );
  });

  it("renders a clean verdict with no divergence table and no plane sections", () => {
    const report = renderCompareReport(CLEAN_FIXTURE);
    expect(report).toContain("**Verdict: CLEAN** (confidence: high)");
    expect(report).not.toContain("| Plane |");
    expect(report).not.toContain("## Database rows");
    expect(report).toContain("9 expected-variance difference(s) suppressed");
  });

  it("names releases instead of bare session ids when release info exists", () => {
    const withReleases: SessionComparison = {
      ...REGRESSION_FIXTURE,
      a: { sessionId: "ses_base_001", release: "R181", build: "sha-a" },
      b: { sessionId: "ses_head_002", release: "R182", build: "sha-b" },
    };
    const report = renderCompareReport(withReleases);
    expect(report).toContain("# Session comparison - R181 (");
    expect(report).toContain("vs R182 (");
    expect(report).toContain("session ses_base_001");
    expect(report).toContain("build sha-a");

    const summary = formatComparisonSummary(withReleases);
    expect(summary).toContain("crumbtrail-server compare - R181 (");
    expect(summary).toContain("vs R182 (");
  });

  it("renders the env delta as an added/removed/changed diff block", () => {
    const withEnvDelta: SessionComparison = {
      ...CLEAN_FIXTURE,
      verdict: "regression",
      envDelta: {
        flags: {
          added: [{ key: "betaSearch", after: true }],
          removed: [{ key: "legacyBanner", before: true }],
          changed: [{ key: "newCheckout", before: false, after: true }],
        },
        config: { added: [], removed: [], changed: [] },
        release: { before: "R181", after: "R182" },
      },
      divergences: [
        {
          plane: "env",
          kind: "env.snapshot",
          before: { flags: { newCheckout: false } },
          after: { flags: { newCheckout: true } },
          brief:
            "environment delta between sessions: 3 flag(s), release changed",
          envDelta: {
            flags: {
              added: [{ key: "betaSearch", after: true }],
              removed: [{ key: "legacyBanner", before: true }],
              changed: [{ key: "newCheckout", before: false, after: true }],
            },
            config: { added: [], removed: [], changed: [] },
            release: { before: "R181", after: "R182" },
          },
        },
      ],
    };
    const report = renderCompareReport(withEnvDelta);
    expect(report).toContain("## Environment and flags");
    expect(report).toContain("+ flags.betaSearch: true");
    expect(report).toContain("- flags.legacyBanner: true");
    expect(report).toContain("~ flags.newCheckout: false -> true");
    expect(report).toContain('~ release: "R181" -> "R182"');
  });

  it("escapes pipes and newlines inside table cells", () => {
    const nasty: SessionComparison = {
      ...CLEAN_FIXTURE,
      verdict: "regression",
      divergences: [
        {
          plane: "network",
          kind: "net.body",
          before: "a",
          after: "b",
          brief: "body a|b changed\nacross lines",
        },
      ],
    };
    const report = renderCompareReport(nasty);
    expect(report).toContain("body a\\|b changed across lines");
  });
});

describe("formatComparisonSummary", () => {
  it("prints verdict, alignment, divergences, and noise on stdout-style lines", () => {
    const summary = formatComparisonSummary(REGRESSION_FIXTURE);
    expect(summary).toContain(
      "crumbtrail-server compare - ses_base_001 vs ses_head_002",
    );
    expect(summary).toContain("Verdict:     REGRESSION (confidence high)");
    expect(summary).toContain(
      "Alignment:   12 matched · 0 only in A · 1 only in B",
    );
    expect(summary).toContain("Divergences: 3");
    expect(summary).toContain("[db] db.row-value - orders row id=41");
    expect(summary).toContain(
      "Noise:       7 suppressed (timestamp-fields, generated-ids)",
    );
  });

  it("caps the divergence list at 5 and points at --json/--report for the rest", () => {
    const many: SessionComparison = {
      ...REGRESSION_FIXTURE,
      divergences: Array.from({ length: 7 }, (_, i) => ({
        plane: "network" as const,
        kind: "net.status",
        before: 200,
        after: 500,
        brief: `divergence ${i}`,
      })),
    };
    const summary = formatComparisonSummary(many);
    expect(summary).toContain(
      "... and 2 more (use --json or --report for the complete list)",
    );
  });
});
