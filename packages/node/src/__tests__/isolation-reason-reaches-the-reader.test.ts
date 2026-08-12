// The SDK knows WHY it could not attach a signal, and routes that reason to a document the reader
// never receives. `isolationCause` is computed for every isolated candidate and rendered only into
// `CANDIDATES.md`; the rendered bundle the product ships — `llm.md` — carries the `Support` grade
// and nothing about what produced it. So a reader is told a headline is `unattached` and cannot
// tell "nothing of this kind was in the session" from "something was, and this signal lost it to
// another finding" — two situations that call for opposite next moves.
//
// This file pins the reason reaching the `llm.md` RENDER PATH. It asserts nothing about
// `CANDIDATES.md` (already covered elsewhere) and nothing about ORDER: the reason is a disclosure
// beside the grade, never a reason to move a row. The `Support` grade itself is deliberately left
// whole — the three states are unchanged and no variant is added.
//
// Everything enters through the public `buildLlmBundle` -> `renderLlmMarkdown` pair, and every
// assertion is made on the rendered markdown STRING, never on a typed field. A test that read a
// new field would fail to compile before the change and would prove only that the field is
// missing, not that the reader is uninformed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";
import { buildEvidenceCandidates, type EvidenceCandidate } from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function sessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-reason-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "s1", app: "test", env: "local" }),
  );
  return dir;
}

interface Rendered {
  markdown: string;
  candidates: EvidenceCandidate[];
}

/**
 * Renders a session the way the product does.
 *
 * `withGraph: false` is the real no-causal-graph path, not a mock: `applyCausalRerank` only
 * attributes when a non-empty graph exists, so `causalRole` stays `undefined` and the row grades
 * `not-assessed`. That state is unexercised by the captured corpus, which makes it the one state
 * nothing has ever proven renders sanely.
 */
function render(
  events: BugEvent[],
  index: Record<string, unknown>,
  { withGraph = true }: { withGraph?: boolean } = {},
): Rendered {
  const graph = withGraph ? buildCausalGraph({ events }) : undefined;
  const candidates = buildEvidenceCandidates(events, index as never, graph);
  const bundle = buildLlmBundle({
    sessionDir: sessionDir(),
    events,
    index,
    candidates,
  } as never);
  return { markdown: renderLlmMarkdown(bundle), candidates };
}

function detectedSignalsSection(markdown: string): string {
  const after = markdown.split("## Detected Signals")[1];
  if (after === undefined) throw new Error("no Detected Signals section rendered");
  return after.split("\n## ")[0];
}

function headerCells(markdown: string): string[] {
  const header = detectedSignalsSection(markdown)
    .split("\n")
    .find((line) => line.startsWith("|"));
  if (!header) throw new Error("Detected Signals rendered no table");
  return header
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function rowCells(markdown: string, detector: string): string[] {
  const row = detectedSignalsSection(markdown)
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`| ${detector} |`));
  if (!row) throw new Error(`no Detected Signals row for detector ${detector}`);
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function cell(markdown: string, detector: string, column: string): string {
  const columns = headerCells(markdown);
  const at = columns.indexOf(column);
  expect(
    at,
    `Detected Signals has no ${column} column; columns are ${JSON.stringify(columns)}`,
  ).toBeGreaterThanOrEqual(0);
  return rowCells(markdown, detector)[at];
}

/** The column carrying the reason. Named once so the test states the contract in one place. */
const REASON_COLUMN = "Why unattached";

// --- fixtures ---------------------------------------------------------------------------------
// Ordinary sessions, not replays of any incident. Each is chosen for the SHAPE of its attribution,
// which is the only thing under test.

/** A click the graph can place: it becomes a root. */
function interceptedClick(): BugEvent {
  return {
    t: 1_500,
    k: "clk",
    d: {
      el: { tag: "DIV", id: "overlay", path: "div[id=overlay]" },
      pos: [10, 10],
      box: { w: 1280, h: 720, viewportPct: 100 },
      covered: [
        {
          tag: "BUTTON",
          path: "button[data-testid=checkout]",
          box: { w: 170, h: 37, viewportPct: 1 },
        },
      ],
    },
  } as unknown as BugEvent;
}

/** A marker the user dropped. Real signal, no node family, so the graph can never place it. */
function voiceMarker(): BugEvent {
  return {
    t: 2_000,
    k: "media.voice",
    d: { state: "marker-added", label: "it froze here", markerId: "m1" },
  } as unknown as BugEvent;
}

function write(
  t: number,
  op: string,
  table: string,
  pk: Record<string, unknown>,
  after: Record<string, unknown>,
  requestId = "req-checkout",
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op, table, pk, after, requestId },
  } as unknown as BugEvent;
}

const BASE_INDEX = { id: "s1", start: 900, end: 90_000, dur: 89_100 };

/**
 * One request, one write (one node), plus a runtime error carrying that request id. The error
 * contributes a candidate but no node of its own, scores above the write and arrives after it, so
 * it LOSES the request's only node: `lost-contention`, with the write holding the node.
 */
const CONTENTION_INDEX = {
  ...BASE_INDEX,
  errs: [
    {
      t: 1_600,
      msg: "TypeError: cannot read properties of undefined (reading 'total')",
      requestId: "req-checkout",
    },
  ],
};

describe("the reason a signal could not be attached reaches the reader", () => {
  it("tells the reader WHY an unattached headline is unattached", () => {
    const { markdown, candidates } = render(
      [interceptedClick(), voiceMarker()],
      BASE_INDEX,
    );

    // Premise. If attribution stops producing this the test proves nothing.
    const marker = candidates.find((c) => c.detector === "user_marker")!;
    expect(marker.causalRole).toBe("isolated");
    expect(marker.isolationCause).toBe("no-node-family");

    // The reader is fed `llm.md` and nothing else, so the reason has to be HERE.
    expect(cell(markdown, "user_marker", "Support")).toBe("unattached");
    expect(cell(markdown, "user_marker", REASON_COLUMN)).toContain(
      "no-node-family",
    );
  });

  it("names WHAT held the node when the signal lost a contest for it", () => {
    // `lost-contention` is not an absence of evidence: something WAS there and this signal lost it.
    // A reader told only "lost-contention" learns strictly less than one told what won.
    const { markdown, candidates } = render(
      [write(1_000, "update", "products", { id: 42 }, { id: 42, price_cents: 8_900 })],
      CONTENTION_INDEX,
    );

    const loser = candidates.find((c) => c.detector === "uncaught_error")!;
    const holder = candidates.find((c) => c.id === loser.contention?.heldBy)!;
    expect(loser.causalRole).toBe("isolated");
    expect(loser.isolationCause).toBe("lost-contention");
    // Premise for the naming assertion: the holder resolves to an emitted candidate.
    expect(holder).toBeDefined();

    const rendered = cell(markdown, "uncaught_error", REASON_COLUMN);
    expect(rendered).toContain("lost-contention");
    // Resolvable by the reader: a detector name, not only an internal id. `llm.md` speaks
    // candidate ids in Causal Structure, so the id may accompany the name — never replace it.
    expect(rendered).toContain(holder.detector);
    expect(rendered).not.toBe(loser.contention?.heldBy);
  });

  it("says nothing at all on a row that was attached", () => {
    // The majority of rows carry no reason, because the question does not arise for them. Absence
    // must render as nothing — an empty cell — rather than as a word a reader could read as an
    // assertion about the row.
    const { markdown } = render([interceptedClick(), voiceMarker()], BASE_INDEX);

    expect(cell(markdown, "click_target_intercepted", "Support")).toBe("attached");
    expect(cell(markdown, "click_target_intercepted", REASON_COLUMN)).toBe("");
  });

  it("says nothing on a not-assessed row, where nothing was ever asked", () => {
    // The no-causal-graph path. Nothing was attributed, so there is no isolation and no reason;
    // a row asserting one here would be inventing an answer to a question never put.
    const { markdown, candidates } = render([interceptedClick()], BASE_INDEX, {
      withGraph: false,
    });

    expect(
      candidates.find((c) => c.detector === "click_target_intercepted")!.causalRole,
    ).toBeUndefined();
    expect(cell(markdown, "click_target_intercepted", "Support")).toBe(
      "not-assessed",
    );
    expect(cell(markdown, "click_target_intercepted", REASON_COLUMN)).toBe("");
  });

  it("glosses the reasons, so the label can be checked rather than trusted", () => {
    // A bare enum is not auditable: the value of this disclosure is a reader who can check the
    // label, which needs the vocabulary explained in the same section.
    const { markdown } = render([interceptedClick(), voiceMarker()], BASE_INDEX);
    const section = detectedSignalsSection(markdown);

    expect(section).toContain("no-node-family");
    expect(section).toContain("lost-contention");
    expect(section).toContain("no-compatible-node");
    // And it must say that a blank cell is not a finding.
    expect(section.toLowerCase()).toContain("blank");
  });

  it("leaves the Support grade whole — three states, no variants", () => {
    // The grade deliberately does not fork on the reason: all three causes mean the same thing for
    // how far to trust a headline. Splitting it would read as degrees of trust it does not carry.
    const { markdown } = render([interceptedClick(), voiceMarker()], BASE_INDEX);

    for (const detector of ["user_marker", "click_target_intercepted"]) {
      expect(["attached", "corroborated", "unattached", "not-assessed"]).toContain(
        cell(markdown, detector, "Support"),
      );
    }
  });
});
