// The base-rate scan runs on the FINALIZE path, where someone is waiting for a bundle, and it
// costs one JSON read and parse per prior session in the store. Uncapped, that is a measurement
// whose cost grows forever: unnoticeable in a store of sixty sessions, seconds in a store of ten
// thousand, and a customer's store only ever grows.
//
// Capping it is only admissible if the number that comes out stays HONEST, which is the whole
// reason the cap was left out the first time. A count over a silently truncated corpus is worse
// than no count, because it is indistinguishable from a complete one. So this file pins the two
// halves together — the bound, and the disclosure that makes the bound safe:
//
//   (a) the scan reads at most the cap, choosing the MOST RECENT prior sessions by a defined,
//       reproducible order, so two runs over one store read the same sessions;
//   (b) when it truncates, the reader is told: the cell names the scanned set
//       (`N of 200 most recent prior sessions`) and the paragraph that explains the column says
//       the older sessions were not read, in either direction;
//   (c) when the store fits under the cap, NOTHING changes — same cell, same prose. A store of
//       sixty renders exactly what it rendered before the bound existed.
//
// Every fixture is synthetic and built here. The detector names exist only in this file, and no
// captured corpus, scenario or ground-truth file is consulted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvidenceCandidate } from "../evidence-index";
import { writeLlmBundle } from "../llm-bundle";
import {
  MAX_SCANNED_PRIOR_SESSIONS,
  MIN_PRIOR_SESSIONS_FOR_PREVALENCE,
  measureDetectorPrevalence,
} from "../detector-prevalence";

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const PROBE = "synthetic_bounded_probe";
const BASE_RATE_COLUMN = "Base rate";

function newStore(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "base-rate-bounded-"));
  scratch.push(root);
  return root;
}

/** A prior session at `{tenant}/{app}/{date}/{id}`, holding only what the scan reads. */
function writePriorSession(
  root: string,
  date: string,
  sessionId: string,
  detectors: string[],
): string {
  const dir = path.join(root, "local", "synthetic-app", date, sessionId);
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
  return dir;
}

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

/** Finalize a session into `root`, exactly as the writing path does, and return its `llm.md`. */
async function renderInStore(root: string, date: string): Promise<string> {
  const sessionDir = path.join(
    root,
    "local",
    "synthetic-app",
    date,
    "ses_current_000",
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({ id: "ses_current_000", app: "synthetic-app", env: "local" }),
  );
  await writeLlmBundle({
    sessionDir,
    events: [],
    index: { id: "ses_current_000", start: 1_000, end: 6_000, dur: 5_000 },
    candidates: [candidate("cand_0001", PROBE, 1_500)],
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
    .map((c) => c.trim());
}

function cell(markdown: string, detector: string, column: string): string {
  const columns = headerCells(markdown);
  const at = columns.indexOf(column);
  expect(at, `no ${column} column; columns are ${JSON.stringify(columns)}`).toBeGreaterThanOrEqual(0);
  const row = detectedSignalsSection(markdown)
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`| ${detector} |`));
  if (!row) throw new Error(`no Detected Signals row for detector ${detector}`);
  return row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim())[at];
}

describe("the base-rate scan is bounded, and says so when the bound bites", () => {
  it("reads at most the cap, and reads the MOST RECENT sessions by a reproducible order", async () => {
    // Four sessions on each of six days. The documented order is date descending, then session id
    // descending, so a cap of six must select the whole newest day and the top two of the day
    // before it — and nothing else. Each session carries a detector naming itself, so the result
    // says exactly WHICH sessions were read rather than only how many.
    const root = newStore();
    const days = ["01", "02", "03", "04", "05", "06"];
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d"];
    for (const day of days)
      for (const id of ids)
        writePriorSession(root, `2026-01-${day}`, id, [`${PROBE}_${day}_${id}`]);

    const cap = 6;
    const measured = await measureDetectorPrevalence({
      // A session of its own, outside the store: every session in the store is a prior.
      sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), "base-rate-self-")),
      corpusRoot: root,
      maxScannedSessions: cap,
      minPriorSessions: cap,
    });

    expect(measured?.priorSessions).toBe(cap);
    expect(measured?.truncated).toBe(true);
    // The exact scanned set, not merely its size: newest day in full, then the two highest ids of
    // the day before. An arbitrary "first six the filesystem handed us" cannot satisfy this.
    expect(Object.keys(measured?.firedIn ?? {}).sort()).toEqual(
      [
        `${PROBE}_06_ses_d`,
        `${PROBE}_06_ses_c`,
        `${PROBE}_06_ses_b`,
        `${PROBE}_06_ses_a`,
        `${PROBE}_05_ses_d`,
        `${PROBE}_05_ses_c`,
      ].sort(),
    );
  });

  it("names the SCANNED set in the cell, never the store it did not read", async () => {
    // A store larger than the shipped cap, rendered through the real finalize path with the real
    // default. The cell must name what was read. A denominator standing for sessions nobody opened
    // is the fabricated number this column exists to avoid, wearing a bigger figure.
    const root = newStore();
    const overCap = MAX_SCANNED_PRIOR_SESSIONS + 40;
    for (let at = 0; at < overCap; at += 1)
      writePriorSession(root, "2026-01-02", `ses_prior_${String(at).padStart(4, "0")}`, [PROBE]);

    const markdown = await renderInStore(root, "2026-01-02");
    const text = cell(markdown, PROBE, BASE_RATE_COLUMN);

    expect(text).toBe(
      `${MAX_SCANNED_PRIOR_SESSIONS} of ${MAX_SCANNED_PRIOR_SESSIONS} most recent prior sessions`,
    );
    // The store's size appears nowhere in the section: it was never measured.
    expect(detectedSignalsSection(markdown)).not.toContain(String(overCap));
  });

  it("tells the reader, in prose, that the older sessions were not read", async () => {
    // The cell alone is not enough. The paragraph above it says what the denominator MEANS, and
    // under a cap the unqualified sentence is false — a truthful cell under a false paragraph is
    // still a fabricated measurement.
    const root = newStore();
    for (let at = 0; at < MAX_SCANNED_PRIOR_SESSIONS + 5; at += 1)
      writePriorSession(root, "2026-01-02", `ses_prior_${String(at).padStart(4, "0")}`, [PROBE]);

    const section = detectedSignalsSection(await renderInStore(root, "2026-01-02"));
    expect(section).toContain(
      `measured over the ${MAX_SCANNED_PRIOR_SESSIONS} MOST RECENT prior sessions`,
    );
    // And the disclosure stays a disclosure: it claims nothing about what it did not read.
    expect(section).toContain("nothing here says anything about the older sessions");
  });

  it("changes NOTHING for a store that fits under the cap", async () => {
    // The pin: a store of ordinary size renders the cell and the prose it rendered before the
    // bound existed. A bound that quietly rewords every deployment's bundle is not a bound.
    const root = newStore();
    const priors = MIN_PRIOR_SESSIONS_FOR_PREVALENCE + 8;
    for (let at = 0; at < priors; at += 1)
      writePriorSession(root, "2026-01-02", `ses_prior_${String(at).padStart(4, "0")}`, [PROBE]);

    const markdown = await renderInStore(root, "2026-01-02");
    expect(cell(markdown, PROBE, BASE_RATE_COLUMN)).toBe(`${priors} of ${priors} prior sessions`);
    expect(detectedSignalsSection(markdown)).not.toContain("MOST RECENT");
  });

  it("keeps the cap at or above the disclosure floor", () => {
    // The floor is applied to the SCANNED count. A cap below it would put every store in the world
    // under the floor and delete the column everywhere, silently and for a performance reason.
    expect(MAX_SCANNED_PRIOR_SESSIONS).toBeGreaterThanOrEqual(MIN_PRIOR_SESSIONS_FOR_PREVALENCE);
  });
});
