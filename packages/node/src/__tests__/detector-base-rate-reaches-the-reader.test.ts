// A detector's CROSS-SESSION base rate, and whether the reader is ever shown it.
//
// Every grade the signal table carries is computed inside one session. Severity is a per-detector
// constant. `Support` measures how well a signal connected to the rest of THIS session — and an
// application's standing background condition is, by construction, the best-connected thing in
// every session it appears in, so the most reassuring grade lands on the wallpaper and the reader
// acts on it as the headline. Nothing in a per-session analysis can tell those apart, because the
// distinguishing fact lives in the OTHER sessions.
//
// This file pins BOTH directions of the new observable, and it is deliberately about the RENDERED
// STRING rather than a typed field: a test that read a field would prove the field exists, not
// that the reader is informed.
//
//   (a) below the prior-session floor the cell is BLANK — no `0%`, no `100%`, no "unique", no
//       "first occurrence". A brand-new application has no priors, so unknown is this value's
//       DEFAULT state, and a default state that renders as an assertion is a number that cannot
//       tell "we looked and found nothing" from "we never looked".
//   (b) above the floor a detector seen in most prior sessions renders a measurably higher count
//       than one seen in few.
//
// Every fixture is synthetic and self-contained: the store is built here, session by session, and
// the two detector names exist only in this file. Nothing is replayed and no captured corpus,
// scenario or ground-truth file is consulted.
//
// It asserts nothing about ORDER. The base rate is a disclosure beside the row, never a reason to
// move one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceCandidate } from "../evidence-index";
import { writeLlmBundle } from "../llm-bundle";
import { MIN_PRIOR_SESSIONS_FOR_PREVALENCE } from "../detector-prevalence";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Two detectors that exist nowhere but here: one common in the store, one rare. */
const COMMON = "synthetic_common_probe";
const RARE = "synthetic_rare_probe";

const BASE_RATE_COLUMN = "Base rate";

/** A finalized session's place in a store: `{tenant}/{app}/{YYYY-MM-DD}/{sessionId}`. */
function partition(root: string, sessionId: string): string {
  return path.join(root, "local", "synthetic-app", "2026-01-02", sessionId);
}

/**
 * A prior session, reduced to exactly what a base-rate scan reads: the `meta.json` that makes a
 * directory a session, and the finalized bundle's detector list.
 */
function writePriorSession(
  root: string,
  sessionId: string,
  detectors: string[],
): void {
  const dir = partition(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: sessionId, app: "synthetic-app", env: "local" }),
  );
  fs.writeFileSync(
    path.join(dir, "llm.json"),
    JSON.stringify({
      distinctBugs: detectors.map((detector, at) => ({
        bugId: `bug_${at}`,
        representative: { detector, title: detector },
      })),
    }),
  );
}

/**
 * A store holding `priors` prior sessions, in which COMMON fired in a clear majority and RARE in
 * a small minority. The two counts are returned rather than recomputed by the assertions, so a
 * test can never agree with itself about a fixture it built.
 */
function storeWithPriors(priors: number): {
  root: string;
  common: number;
  rare: number;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "detector-base-rate-"));
  scratch.push(root);
  let common = 0;
  let rare = 0;
  for (let at = 0; at < priors; at += 1) {
    const detectors: string[] = [];
    // Majority vs minority, and neither is 0 or all of them: the point is that the column
    // separates common from rare, which a saturated fixture would not test.
    if (at % 4 !== 0) {
      detectors.push(COMMON);
      common += 1;
    }
    if (at % 5 === 0) {
      detectors.push(RARE);
      rare += 1;
    }
    detectors.push(`synthetic_filler_${at}`);
    writePriorSession(root, `ses_prior_${String(at).padStart(3, "0")}`, detectors);
  }
  return { root, common, rare };
}

/** One ranked candidate. Hand-built so the rendered rows carry the synthetic detectors. */
function candidate(id: string, detector: string, t: number): EvidenceCandidate {
  return {
    schemaVersion: 1,
    id,
    detector,
    title: `${detector} fired`,
    severity: "high",
    score: 50,
    anchor: { t },
    evidenceWindow: { start: t - 500, end: t + 500 },
    evidence: [],
  } as unknown as EvidenceCandidate;
}

/**
 * Renders a session INTO a store, exactly as a finalize does, and returns its `llm.md`.
 *
 * Goes through `writeLlmBundle` rather than `buildLlmBundle` on purpose: the corpus scan is the
 * part under test, and it belongs to the writing path — `buildLlmBundle` stays a pure function of
 * a single session and would render nothing to prove.
 */
async function renderInStore(
  root: string,
  { corpusRoot }: { corpusRoot?: string } = {},
): Promise<string> {
  const sessionDir = partition(root, "ses_current_000");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({ id: "ses_current_000", app: "synthetic-app", env: "local" }),
  );
  await writeLlmBundle({
    sessionDir,
    events: [],
    index: { id: "ses_current_000", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [candidate("cand_0001", COMMON, 1_500), candidate("cand_0002", RARE, 2_500)],
    ...(corpusRoot !== undefined ? { corpusRoot } : {}),
  } as never);
  return fs.readFileSync(path.join(sessionDir, "llm.md"), "utf-8");
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

function cell(markdown: string, detector: string, column: string): string {
  const columns = headerCells(markdown);
  const at = columns.indexOf(column);
  expect(
    at,
    `Detected Signals has no ${column} column; columns are ${JSON.stringify(columns)}`,
  ).toBeGreaterThanOrEqual(0);
  const row = detectedSignalsSection(markdown)
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`| ${detector} |`));
  if (!row) throw new Error(`no Detected Signals row for detector ${detector}`);
  return row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim())[at];
}

/** The count out of a `N of M prior sessions` cell. Fails loudly on any other shape. */
function countIn(cellText: string): { fired: number; priors: number } {
  const match = /^(\d+) of (\d+) prior sessions$/.exec(cellText);
  if (!match) throw new Error(`base-rate cell is not a count with its denominator: ${cellText}`);
  return { fired: Number(match[1]), priors: Number(match[2]) };
}

describe("a detector's cross-session base rate reaches the reader", () => {
  it("renders a higher base rate for a detector most prior sessions saw than for one few did", async () => {
    const { root, common, rare } = storeWithPriors(MIN_PRIOR_SESSIONS_FOR_PREVALENCE + 8);
    const markdown = await renderInStore(root);

    const commonCell = countIn(cell(markdown, COMMON, BASE_RATE_COLUMN));
    const rareCell = countIn(cell(markdown, RARE, BASE_RATE_COLUMN));

    // The fixture's own counts, so this measures the scan rather than agreeing with itself.
    expect(commonCell.fired).toBe(common);
    expect(rareCell.fired).toBe(rare);
    expect(commonCell.fired).toBeGreaterThan(rareCell.fired);
    // The denominator is the priors and never counts the session being rendered as its own prior.
    expect(commonCell.priors).toBe(MIN_PRIOR_SESSIONS_FOR_PREVALENCE + 8);
    expect(rareCell.priors).toBe(commonCell.priors);
    // Majority vs minority is the distinction the column exists to draw.
    expect(commonCell.fired * 2).toBeGreaterThan(commonCell.priors);
    expect(rareCell.fired * 2).toBeLessThan(rareCell.priors);
  });

  it("renders the cell BLANK, asserting nothing, when the store holds too few prior sessions", async () => {
    const { root } = storeWithPriors(MIN_PRIOR_SESSIONS_FOR_PREVALENCE - 1);
    const markdown = await renderInStore(root);

    // The column is still there — the reader is told the question exists — and the cell is empty.
    expect(headerCells(markdown)).toContain(BASE_RATE_COLUMN);
    expect(cell(markdown, COMMON, BASE_RATE_COLUMN)).toBe("");
    expect(cell(markdown, RARE, BASE_RATE_COLUMN)).toBe("");

    // And the absence is nowhere turned into an assertion, in the cell or in the prose around it.
    const section = detectedSignalsSection(markdown);
    for (const forbidden of ["0%", "100%", "unique", "first occurrence", "never seen"]) {
      expect(
        section.toLowerCase().includes(forbidden.toLowerCase()),
        `Detected Signals asserts "${forbidden}" about a value it does not have`,
      ).toBe(false);
    }
  });

  it("renders blank for a session sitting alone in a store of its own, rather than 1 of 1", async () => {
    // The replay/import situation: the derived corpus is the session's own parent and holds
    // nothing else. An observable that inferred its corpus would call every detector universal.
    const { root } = storeWithPriors(0);
    const markdown = await renderInStore(root);
    expect(cell(markdown, COMMON, BASE_RATE_COLUMN)).toBe("");
    expect(detectedSignalsSection(markdown)).not.toContain("of 1 prior sessions");
  });

  it("measures against an EXPLICIT corpus root when the session's own parent is not the corpus", async () => {
    // Same lone session as above, pointed at a populated corpus instead. This is the seam a
    // measurement pass needs, and without it a replayed session can only ever answer about itself.
    const { root: corpus, common } = storeWithPriors(MIN_PRIOR_SESSIONS_FOR_PREVALENCE + 3);
    const { root: alone } = storeWithPriors(0);
    const markdown = await renderInStore(alone, { corpusRoot: corpus });
    expect(countIn(cell(markdown, COMMON, BASE_RATE_COLUMN)).fired).toBe(common);
  });
});
