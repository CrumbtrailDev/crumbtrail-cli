import { describe, expect, it } from "vitest";
import { inferIntent } from "../intent";
import type { CommitInfo } from "../intent";
import type { EvidenceItem } from "../evidence";

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "id-1",
    lane: "network",
    kind: "net.status",
    brief: "generic evidence",
    ref: {},
    before: undefined,
    after: undefined,
    ...overrides,
  };
}

describe("inferIntent", () => {
  it("explains a net.status item via a commit touching the matching route file", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        ref: { sig: "POST /checkout" },
        brief: "checkout validation issue",
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "a1",
        message: "refactor checkout validation",
        files: ["src/routes/checkout.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(1);
    expect(signals[0].evidenceId).toBe("net-1");
    expect(signals[0].explainedByCommit?.sha).toBe("a1");
    expect(signals[0].prIntent).toBe("refactor checkout validation");
  });

  it("explains a db item via a commit touching the matching table file", () => {
    const evidence = [
      item({
        id: "db-1",
        lane: "db",
        kind: "db.row-value",
        ref: { table: "orders" },
        brief: "orders total mismatch",
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "b2",
        message: "fix orders total calculation",
        files: ["src/db/orders.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(1);
    expect(signals[0].evidenceId).toBe("db-1");
    expect(signals[0].explainedByCommit?.sha).toBe("b2");
  });

  it("emits no signal for evidence with no overlapping commit", () => {
    const evidence = [
      item({
        id: "net-unexplained",
        lane: "network",
        kind: "net.status",
        ref: { sig: "GET /profile" },
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "c3",
        message: "update marketing copy",
        files: ["src/marketing/hero.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals.map((s) => s.evidenceId)).not.toContain("net-unexplained");
    expect(signals).toHaveLength(0);
  });

  it("picks the commit with the most shared tokens; ties broken by smallest sha", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        ref: { sig: "POST /checkout" },
        brief: "checkout submit failing",
      }),
    ];
    const weakerMatch: CommitInfo = {
      sha: "z9",
      message: "checkout tweak",
      files: ["src/routes/checkout.ts"],
    };
    const strongerMatch: CommitInfo = {
      sha: "a1",
      message: "checkout submit fix",
      files: ["src/routes/checkout.ts", "src/submit/checkout.ts"],
    };

    const signals = inferIntent(evidence, [weakerMatch, strongerMatch]);

    expect(signals).toHaveLength(1);
    expect(signals[0].explainedByCommit?.sha).toBe("a1");
  });

  it("breaks exact ties by lexicographically smallest sha", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        ref: { sig: "POST /checkout" },
        brief: "checkout routes broken",
      }),
    ];
    const commitB: CommitInfo = {
      sha: "bbb",
      message: "checkout routes fix",
      files: ["src/routes/checkout.ts"],
    };
    const commitA: CommitInfo = {
      sha: "aaa",
      message: "checkout routes fix",
      files: ["src/routes/checkout.ts"],
    };

    const signals = inferIntent(evidence, [commitB, commitA]);

    expect(signals).toHaveLength(1);
    expect(signals[0].explainedByCommit?.sha).toBe("aaa");
  });

  it("does not explain via a single incidental shared token", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        ref: { sig: "GET /users" },
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "d4",
        message: "get rid of dead code",
        files: ["src/misc/cleanup.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(0);
  });

  it("fires via strong identity-path match for a single-resource network route (production-shaped)", () => {
    const evidence = [
      item({
        id: "e-net",
        lane: "network",
        kind: "net.status",
        brief: "network status changed for POST /api/checkout: 200 -> 500",
        ref: { sig: "checkout-submit" },
        before: 200,
        after: 500,
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "c1",
        message: "refactor cart validation",
        files: ["src/routes/checkout.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(1);
    expect(signals[0].evidenceId).toBe("e-net");
    expect(signals[0].explainedByCommit?.sha).toBe("c1");
  });

  it("fires via strong identity-path match for a single-resource db table (production-shaped)", () => {
    const evidence = [
      item({
        id: "e-db",
        lane: "db",
        kind: "db.row-value",
        brief: "database row value changed for orders",
        ref: { table: "orders" },
        before: {},
        after: {},
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "c2",
        message: "tweak pricing logic",
        files: ["src/db/orders.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(1);
    expect(signals[0].evidenceId).toBe("e-db");
    expect(signals[0].explainedByCommit?.sha).toBe("c2");
  });

  it("does not fire when the only path overlap is a structural token", () => {
    const evidence = [
      item({
        id: "e-net-structural",
        lane: "network",
        kind: "net.status",
        brief: "network status changed for POST /api/checkout: 200 -> 500",
        ref: { sig: "checkout-submit" },
        before: 200,
        after: 500,
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "c3",
        message: "chore: bump",
        files: ["src/api/index.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(0);
  });

  it("does not fire for a genuinely unrelated commit", () => {
    const evidence = [
      item({
        id: "e-net-unrelated",
        lane: "network",
        kind: "net.status",
        brief: "network status changed for POST /api/checkout: 200 -> 500",
        ref: { sig: "checkout-submit" },
        before: 200,
        after: 500,
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "c4",
        message: "add invoice pdf",
        files: ["src/routes/billing.ts"],
      },
    ];

    const signals = inferIntent(evidence, commits);

    expect(signals).toHaveLength(0);
  });

  it("is deterministic across repeated calls", () => {
    const evidence = [
      item({
        id: "net-1",
        lane: "network",
        kind: "net.status",
        ref: { sig: "POST /checkout" },
      }),
    ];
    const commits: CommitInfo[] = [
      {
        sha: "a1",
        message: "refactor checkout validation",
        files: ["src/routes/checkout.ts"],
      },
    ];

    const first = inferIntent(evidence, commits);
    const second = inferIntent(evidence, commits);

    expect(first).toEqual(second);
  });
});
