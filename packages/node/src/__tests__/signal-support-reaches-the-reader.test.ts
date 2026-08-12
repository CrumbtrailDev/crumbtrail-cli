// The SDK computes how well it could ATTACH a signal to this session's causal graph, and then
// throws that away before the reader sees anything. `causalRole` reaches the emitted candidate and
// dies there: `renderDetectedSignalsSection` prints severity, detector, finding and location, so a
// signal the SDK itself could not place in the chain of events renders identically to one it
// placed and corroborated. The reader is given a headline and no way to tell how much of the
// session's evidence stands behind it.
//
// This file pins the DISCLOSURE, and nothing else. It deliberately asserts nothing about ORDER:
// the SDK's own measurement is that the top-ranked candidate is frequently `isolated` and is
// frequently also the detector that names the incident, so demoting unattached signals would bury
// correct findings. Support is a qualifier on a headline, never a reason to move it.
//
// Everything here enters through the public `buildLlmBundle` -> `renderLlmMarkdown` pair, because
// `renderDetectedSignalsSection` is not exported and must not become exported to be testable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildLlmBundle, renderLlmMarkdown } from "../llm-bundle";
import {
  buildEvidenceCandidates,
  writeEvidenceIndex,
  type EvidenceCandidate,
} from "../evidence-index";
import { buildCausalGraph } from "../causal-graph";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function sessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-support-"));
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
  bundle: ReturnType<typeof buildLlmBundle>;
}

/**
 * Renders a session the way the product does.
 *
 * `withGraph: false` is not a mock — it is the real path taken when no causal graph was built for
 * the session. `applyCausalRerank` only attributes when a non-empty graph is supplied, so that path
 * leaves `causalRole` genuinely `undefined` rather than `"isolated"`, and the difference between
 * "could not attach it" and "never asked" has to survive all the way to the reader.
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
  return { markdown: renderLlmMarkdown(bundle), candidates, bundle };
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

/** The rendered Support cell for the row whose detector cell is `detector`. */
function supportCell(markdown: string, detector: string): string {
  const columns = headerCells(markdown);
  const column = columns.indexOf("Support");
  // The whole point of the change: without this column the reader has no way to tell an
  // unattached headline from a corroborated one.
  expect(
    column,
    `Detected Signals has no Support column; columns are ${JSON.stringify(columns)}`,
  ).toBeGreaterThanOrEqual(0);

  const row = detectedSignalsSection(markdown)
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`| ${detector} |`));
  if (!row) throw new Error(`no Detected Signals row for detector ${detector}`);
  return row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim())[column];
}

// --- fixtures ---------------------------------------------------------------------------------
// These are ordinary sessions, not replays of any particular incident. What each one is chosen for
// is the SHAPE of its attribution — attached, unattached, corroborated, unassessed — because that
// shape is the only thing under test.

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

describe("a signal's support for its own headline reaches the reader", () => {
  it("distinguishes a signal the graph placed from one it could not", () => {
    // One session, two findings: an intercepted click the graph attaches, and a user marker that
    // has no node family and therefore cannot be attached to anything.
    const { markdown, candidates } = render(
      [interceptedClick(), voiceMarker()],
      BASE_INDEX,
    );

    // Premise. If attribution stops producing this pair the test proves nothing.
    const click = candidates.find((c) => c.detector === "click_target_intercepted")!;
    const marker = candidates.find((c) => c.detector === "user_marker")!;
    expect(click.causalRole).toBe("root");
    expect(marker.causalRole).toBe("isolated");

    expect(supportCell(markdown, "user_marker")).toBe("unattached");
    expect(supportCell(markdown, "click_target_intercepted")).toBe("attached");
    // Two findings in one table must not read the same when the SDK's own confidence in them
    // differs. This is the failure being closed.
    expect(supportCell(markdown, "user_marker")).not.toBe(
      supportCell(markdown, "click_target_intercepted"),
    );
  });

  it("keeps `not-assessed` distinct from `unattached` on the same events", () => {
    // The same events, rendered once with a causal graph and once without. Without one, nothing
    // was attributed at all — which is a different statement to the reader than "I tried to place
    // this and failed", and collapsing the two would re-hide exactly what this change discloses.
    const events = [interceptedClick()];
    const assessed = render(events, BASE_INDEX);
    const unassessed = render(events, BASE_INDEX, { withGraph: false });

    expect(
      unassessed.candidates.find((c) => c.detector === "click_target_intercepted")!
        .causalRole,
    ).toBeUndefined();

    expect(supportCell(unassessed.markdown, "click_target_intercepted")).toBe(
      "not-assessed",
    );
    expect(supportCell(assessed.markdown, "click_target_intercepted")).toBe(
      "attached",
    );
    expect(supportCell(unassessed.markdown, "click_target_intercepted")).not.toBe(
      "unattached",
    );
  });

  it("reads a root with symptoms attributed to it as corroborated", () => {
    // A root that explains something else in the session has more of the session's evidence behind
    // it than a root that explains nothing, and the grade says so.
    const { markdown, candidates } = render(
      [
        write(1_100, "update", "products", { id: 42 }, { id: 42, price_cents: 8_900 }),
        write(
          1_200,
          "insert",
          "order_items",
          { id: 7 },
          { id: 7, product_id: 42, price_cents: 7_900 },
        ),
      ],
      BASE_INDEX,
    );

    const root = candidates.find((c) => c.detector === "db_field_divergence")!;
    expect(root.causalRole).toBe("root");
    expect(root.causes?.length).toBeGreaterThan(0);

    expect(supportCell(markdown, "db_field_divergence")).toBe("corroborated");
  });

  it("grades the row from its REPRESENTATIVE, never the best-supported member", () => {
    // The trap this assertion exists for. A bug's title and detector come from its representative,
    // while its severity is a cluster MAX. A support grade mirrored as a cluster max would print a
    // reassuring word on a row whose headline belongs to a member the SDK could not place at all —
    // the same defect one field over.
    //
    // Shape: one request, one write (one node), plus a runtime error reported through the index
    // with no captured event of its own. The error therefore contributes a candidate but NO node,
    // scores above the write, and arrives after it — so it loses the request's only node and is
    // isolated, while the lower-scoring write it clusters with is attached.
    const { markdown, candidates, bundle } = render(
      [write(1_000, "update", "products", { id: 42 }, { id: 42, price_cents: 8_900 })],
      {
        ...BASE_INDEX,
        errs: [
          {
            t: 1_600,
            msg: "TypeError: cannot read properties of undefined (reading 'total')",
            requestId: "req-checkout",
          },
        ],
      },
    );

    const bug = bundle.distinctBugs.find(
      (b) => b.representative.detector === "uncaught_error",
    )!;
    // Premise: ONE bug holding BOTH candidates, so representative-keying and best-member keying
    // can actually disagree here.
    expect(bug.candidateIds.length).toBeGreaterThan(1);

    const members = bug.candidateIds.map(
      (id) => candidates.find((c) => c.id === id)!,
    );
    const representative = members.find((c) => c.detector === "uncaught_error")!;
    const other = members.find((c) => c.detector === "db_mutation")!;
    expect(representative.causalRole).toBe("isolated");
    expect(other.causalRole).toBe("root");
    expect(representative.score).toBeGreaterThan(other.score);

    // What a best-of-members mirror WOULD have rendered. Without this the test cannot tell the
    // correct implementation from the defective one.
    expect(other.support).toBe("attached");
    expect(representative.support).toBe("unattached");
    expect(supportCell(markdown, "uncaught_error")).toBe("unattached");
    expect(supportCell(markdown, "uncaught_error")).not.toBe(other.support);
  });

  it("says WHY an unattached signal could not be attached, where signals are described in full", async () => {
    // The support grade tells a reader HOW FAR to trust a headline. It deliberately does not carry
    // the reason, because all three isolation causes mean the same thing for trust. The reason has
    // been computed and recorded for some time and no document ever printed it, so a reader saw
    // `isolated` with no way to tell "nothing of this kind was here" from "something was, and this
    // signal lost it to another".
    const dir = sessionDir();
    const events = [
      write(1_000, "update", "products", { id: 42 }, { id: 42, price_cents: 8_900 }),
    ];
    const index = {
      ...BASE_INDEX,
      errs: [
        {
          t: 1_600,
          msg: "TypeError: cannot read properties of undefined (reading 'total')",
          requestId: "req-checkout",
        },
      ],
    };
    await writeEvidenceIndex({
      sessionDir: dir,
      events,
      index,
      causalGraph: buildCausalGraph({ events }),
    } as never);

    const rendered = fs.readFileSync(path.join(dir, "CANDIDATES.md"), "utf8");
    expect(rendered).toContain("Causal role: isolated");
    expect(rendered).toContain("Isolation cause: lost-contention");
  });

  it("tells the reader what an unattached headline means for trust", () => {
    const { markdown } = render([interceptedClick(), voiceMarker()], BASE_INDEX);
    const section = detectedSignalsSection(markdown);
    expect(section).toContain("unattached");
    // The grade is useless as a bare word: the reader has to be told that an unattached headline
    // may be unrelated to the reported symptom.
    expect(section.toLowerCase()).toContain("could not");
  });
});
