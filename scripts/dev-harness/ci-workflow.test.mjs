// Guard for the native SDK conformance jobs in .github/workflows/ci.yml.
//
// packages/swift, packages/kotlin and packages/flutter each ship a wire
// contract suite. Those suites are the only thing holding the four SDK
// languages to one envelope shape, and for a long stretch none of them ran in
// CI at all — the anti-drift guarantee was aspirational. This file keeps the
// jobs present AND keeps their failure visible: a `|| true` or a
// `continue-on-error: true` slipped into one of them would turn the job into a
// green check that proves nothing, which is the exact failure mode the jobs
// exist to remove.
//
// The workflow is parsed with a small indentation reader rather than a YAML
// library, because the repo root has no YAML parser on its dependency path and
// this file is not worth a new dependency for. The reader only has to
// understand the shape this workflow actually uses: two-space job keys under a
// column-zero `jobs:`, and `run:` steps in inline or block-scalar form.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows/ci.yml",
);

/**
 * Split the workflow's `jobs:` mapping into `name -> lines`.
 *
 * Comment lines immediately above a job key are attributed to the job they
 * introduce, not to the job above them, so a comment that mentions `|| true`
 * lands where a reader would expect it to.
 */
function readJobs(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  if (start === -1) throw new Error("ci.yml has no top-level `jobs:` mapping");

  const jobs = new Map();
  let current = null;
  let pendingComments = [];

  for (const line of lines.slice(start + 1)) {
    // A non-empty line at column zero ends the `jobs:` mapping.
    if (line.trim() !== "" && !line.startsWith(" ")) break;

    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = [...pendingComments];
      pendingComments = [];
      jobs.set(header[1], current);
      continue;
    }

    if (/^\s*#/.test(line) || line.trim() === "") {
      pendingComments.push(line);
      continue;
    }

    if (current) {
      current.push(...pendingComments, line);
      pendingComments = [];
    }
  }

  return jobs;
}

/**
 * Every shell command a job runs: the value of each `run:` key, with block
 * scalars (`run: |`) collapsed back into their text.
 */
function runCommands(jobLines) {
  const commands = [];

  for (let i = 0; i < jobLines.length; i += 1) {
    const step = /^(\s*)(?:- )?run:\s*(.*)$/.exec(jobLines[i]);
    if (!step) continue;

    const [, indent, inline] = step;

    if (/^[|>][-+0-9]*$/.test(inline.trim())) {
      const body = [];
      for (let j = i + 1; j < jobLines.length; j += 1) {
        const line = jobLines[j];
        if (line.trim() === "") {
          body.push("");
          continue;
        }
        if (line.length - line.trimStart().length <= indent.length) break;
        body.push(line.trim());
      }
      commands.push(body.join("\n"));
      continue;
    }

    if (inline.trim() !== "") commands.push(inline.trim());
  }

  return commands;
}

const source = fs.readFileSync(workflowPath, "utf8");
const jobs = readJobs(source);

/** job name -> the test command it exists to run, and the package it runs in. */
const nativeSuites = {
  swift: { command: /\bswift test\b/, packageDir: "packages/swift" },
  kotlin: { command: /\bgradle test\b/, packageDir: "packages/kotlin" },
  flutter: { command: /\bflutter test\b/, packageDir: "packages/flutter" },
};

describe("native SDK conformance jobs in ci.yml", () => {
  for (const [name, { command, packageDir }] of Object.entries(nativeSuites)) {
    describe(`the \`${name}\` job`, () => {
      it("exists", () => {
        expect([...jobs.keys()]).toContain(name);
      });

      it(`runs a step matching ${command}`, () => {
        const commands = runCommands(jobs.get(name) ?? []);
        expect(commands.some((entry) => command.test(entry))).toBe(true);
      });

      it(`resolves ${packageDir}, rather than running at the repo root`, () => {
        const lines = jobs.get(name) ?? [];
        // Either the command names the package path or the step sets
        // working-directory to it. Both are fine; neither is not.
        expect(lines.some((line) => line.includes(packageDir))).toBe(true);
      });

      it("never swallows a failure with `|| true`", () => {
        const offenders = runCommands(jobs.get(name) ?? []).filter((entry) =>
          entry.includes("|| true"),
        );
        expect(offenders).toEqual([]);
      });

      it("never sets continue-on-error: true", () => {
        const offenders = (jobs.get(name) ?? []).filter((line) =>
          /^\s*(?:- )?continue-on-error:\s*true\b/.test(line),
        );
        expect(offenders).toEqual([]);
      });
    });
  }
});
