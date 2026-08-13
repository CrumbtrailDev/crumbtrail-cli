// A column nobody measured, and the paragraph that teaches how to read it.
//
// The `Base rate` column carries a cross-session measurement, and it is legitimately BLANK
// whenever the store holds too few prior sessions to say anything — which is every session of
// every new application, and every session rendered outside a store. That blank is correct and is
// pinned elsewhere (`detector-base-rate-reaches-the-reader.test.ts`).
//
// What was NOT correct is what shipped ALONGSIDE the blanks. The column header and an 858-byte
// paragraph explaining how to weigh a base rate were emitted unconditionally — so a bundle that
// carries no prevalence measurement at all still spent the reader's context teaching a grade it
// holds no value of, in every row, and then showed them an empty column. The reader pays for the
// lesson and receives no measurement.
//
// The rule this file pins is a property of the DATA IN THE BUNDLE BEING RENDERED, not of any
// case, fixture or corpus:
//
//   when the rendered `Base rate` cell is empty for EVERY row of this bundle, neither the column
//   nor the paragraph that teaches how to read it is emitted; when at least ONE row carries a
//   measurement, both are emitted exactly as before.
//
// Both directions are asserted against the RENDERED STRING, because the defect is about what
// reaches the reader, not about what a field holds. The mixed direction matters most: a single
// measured row is enough to earn the column back, so the suppression can never delete a
// measurement.
//
// Every fixture here is synthetic and self-contained. The detector names exist only in this file;
// the prevalence measurement is handed in directly rather than scanned; and no captured corpus,
// scenario or ground-truth file is consulted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceCandidate } from "../evidence-index";
import { buildLlmBundle, renderLlmMarkdown, writeLlmBundle } from "../llm-bundle";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** Two detectors that exist nowhere but in this file. */
const MEASURED = "synthetic_measured_probe";
const OTHER = "synthetic_other_probe";

const BASE_RATE_COLUMN = "Base rate";

/**
 * The opening of the paragraph that teaches the column, verbatim from the renderer. Matching its
 * distinctive opening rather than the whole 858 bytes keeps this test about PRESENCE; the
 * preserved direction below additionally pins the wording end to end.
 */
const LEGEND_OPENING =
  "`Base rate` is how many of the sessions already recorded for this application";

const LEGEND_CLOSING =
  "Nothing here moves a row: the table is ordered exactly as it would be without this column.";

/** A session directory with the `meta.json` that makes it a session, and nothing else. */
function newSessionDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "base-rate-suppressed-"));
  scratch.push(root);
  const dir = path.join(root, "local", "synthetic-app", "2026-01-02", "ses_current_000");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: "ses_current_000", app: "synthetic-app", env: "local" }),
  );
  return dir;
}

/** One ranked candidate, hand-built so the rendered rows carry the synthetic detectors. */
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

const CANDIDATES = [
  candidate("cand_0001", MEASURED, 1_500),
  candidate("cand_0002", OTHER, 2_500),
];

function bundleInput(sessionDir: string): Record<string, unknown> {
  return {
    sessionDir,
    events: [],
    index: { id: "ses_current_000", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: CANDIDATES,
  };
}

/**
 * A caller-supplied whole-store measurement — the seam `writeLlmBundle` already exposes — so this
 * file never has to build a corpus to earn a populated column.
 */
function measurement(firedIn: Record<string, number>): Record<string, unknown> {
  return {
    corpusRoot: "/synthetic/corpus",
    priorSessions: 40,
    firedIn,
  };
}

async function renderWithPrevalence(
  prevalence: Record<string, unknown> | undefined,
): Promise<string> {
  const sessionDir = newSessionDir();
  await writeLlmBundle({
    ...bundleInput(sessionDir),
    ...(prevalence !== undefined ? { prevalence } : {}),
    // A corpus root that holds nothing: the scan finds no priors, so the ONLY prevalence in play
    // is the one handed in above — or none at all.
    corpusRoot: fs.mkdtempSync(path.join(os.tmpdir(), "base-rate-empty-corpus-")),
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

/** Every row of the table, as trimmed cell arrays. Proves the rows stayed shaped like the header. */
function bodyRows(markdown: string): string[][] {
  return detectedSignalsSection(markdown)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

function cell(markdown: string, detector: string, column: string): string {
  const columns = headerCells(markdown);
  const at = columns.indexOf(column);
  expect(
    at,
    `Detected Signals has no ${column} column; columns are ${JSON.stringify(columns)}`,
  ).toBeGreaterThanOrEqual(0);
  const row = bodyRows(markdown).find((cells) => cells.includes(detector));
  if (!row) throw new Error(`no Detected Signals row for detector ${detector}`);
  return row[at];
}

describe("the Base rate column and its legend are suppressed together when nothing measured it", () => {
  it("emits NEITHER the column NOR its paragraph when no row carries a measurement", async () => {
    const markdown = await renderWithPrevalence(undefined);
    const section = detectedSignalsSection(markdown);

    // The section is still rendered and still carries the signals — the suppression is of one
    // column, never of the table.
    expect(section).toContain(MEASURED);
    expect(section).toContain(OTHER);

    expect(headerCells(markdown)).not.toContain(BASE_RATE_COLUMN);
    expect(section).not.toContain(LEGEND_OPENING);
    expect(section).not.toContain(LEGEND_CLOSING);
    // Not anywhere in the document, not merely outside this section.
    expect(markdown).not.toContain(BASE_RATE_COLUMN);

    // And nothing took its place that asserts a value: an absence turned into a sentence is the
    // same fabricated measurement the blank cell exists to avoid.
    for (const forbidden of ["0%", "100%", "unique", "first occurrence", "never seen"])
      expect(
        section.toLowerCase().includes(forbidden.toLowerCase()),
        `Detected Signals asserts "${forbidden}" about a value it does not have`,
      ).toBe(false);

    // The table stayed well-formed: every row has exactly as many cells as the header.
    const width = headerCells(markdown).length;
    for (const row of bodyRows(markdown)) expect(row.length).toBe(width);
  });

  it("emits BOTH, with the wording unchanged, when a row carries a measurement", async () => {
    const markdown = await renderWithPrevalence(
      measurement({ [MEASURED]: 31, [OTHER]: 0 }),
    );
    const section = detectedSignalsSection(markdown);

    expect(headerCells(markdown)).toContain(BASE_RATE_COLUMN);
    expect(cell(markdown, MEASURED, BASE_RATE_COLUMN)).toBe("31 of 40 prior sessions");
    // A measured zero is a measurement and is printed as one.
    expect(cell(markdown, OTHER, BASE_RATE_COLUMN)).toBe("0 of 40 prior sessions");

    // The paragraph, end to end and byte for byte as it shipped.
    expect(section).toContain(
      "`Base rate` is how many of the sessions already recorded for this application, other than "
        + "this one, the same detector fired in. It answers what no grade above it can: whether the "
        + "finding is peculiar to this incident or a standing condition of the application. A "
        + "detector that fires in most sessions was firing before the reported symptom existed, "
        + "however severe it is and however well it is attached here, and a headline taken from one "
        + "is a lead pointing at the background. A blank cell means the value is UNKNOWN, not low: "
        + "too few sessions are recorded yet to say anything, which is where every application "
        + "starts. Read a low count as \"rarely seen in what has been recorded\" — the store knows "
        + "only the sessions it holds, so it is never proof that a finding is new. Nothing here "
        + "moves a row: the table is ordered exactly as it would be without this column.",
    );

    const width = headerCells(markdown).length;
    for (const row of bodyRows(markdown)) expect(row.length).toBe(width);
  });

  it("emits BOTH when only SOME rows are measured — one measurement earns the column", () => {
    // MIXED. This state is unreachable through `writeLlmBundle`, because the projection
    // zero-fills every detector the session produced, so it is constructed at the
    // `renderLlmMarkdown` boundary, where the published bundle schema permits it: a bundle
    // written by any other producer may carry a per-detector list that names only some rows.
    const bundle = buildLlmBundle({
      ...bundleInput(newSessionDir()),
      prevalence: measurement({ [MEASURED]: 31, [OTHER]: 4 }),
    } as never);

    const prevalence = bundle.detectorPrevalence;
    expect(prevalence, "the projection produced no prevalence to narrow").toBeDefined();
    prevalence!.detectors = prevalence!.detectors.filter(
      (row) => row.detector === MEASURED,
    );
    expect(prevalence!.detectors).toHaveLength(1);

    const markdown = renderLlmMarkdown(bundle);
    const section = detectedSignalsSection(markdown);

    expect(headerCells(markdown)).toContain(BASE_RATE_COLUMN);
    expect(section).toContain(LEGEND_OPENING);
    expect(cell(markdown, MEASURED, BASE_RATE_COLUMN)).toBe("31 of 40 prior sessions");
    // The unmeasured row keeps its blank cell: suppression is all-or-nothing per bundle, and a
    // per-row absence still renders as nothing rather than as a number.
    expect(cell(markdown, OTHER, BASE_RATE_COLUMN)).toBe("");

    const width = headerCells(markdown).length;
    for (const row of bodyRows(markdown)) expect(row.length).toBe(width);
  });
});
