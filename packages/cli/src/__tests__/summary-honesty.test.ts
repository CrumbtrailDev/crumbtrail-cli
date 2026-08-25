// The run summary may only certify what the run actually did.
//
// Two ways it stopped being true, both found by putting a person in front of a
// real monorepo install:
//
//   1. `correlationNotes` printed "Frontend to backend correlation enabled" from
//      the recipe and the origin list alone. Neither says whether the init that
//      carries `networkCorrelationAllowedOrigins` ever reached a file — so a
//      service whose injection fell back to a paste-this snippet was told the
//      join was on, and a Tauri service was told it over a snippet that has no
//      such field anywhere in it.
//   2. A service whose ingest key the endpoint had just refused with a 401 still
//      wore the success tick and was counted in "2 wired", two lines above the
//      warning saying it would never report.

import { describe, expect, it } from "vitest";
import {
  correlationNotes,
  printBatchSummary,
  type ServiceOutcome,
} from "../cli";
import { glyphs } from "../theme";

const ORIGINS = ["http://localhost:4000"];

describe("correlationNotes only claims what was written", () => {
  it("states the join as live when the init was actually injected", () => {
    const [note] = correlationNotes("vite-spa", ORIGINS, 1, "wired");
    expect(note).toMatch(/^Frontend to backend correlation enabled for/);
  });

  it("speaks in the future tense when injection fell back to a snippet", () => {
    const [note] = correlationNotes("vite-spa", ORIGINS, 1, "guidance");
    expect(note).toMatch(/not enabled until you paste it in/);
    expect(note).not.toMatch(/correlation enabled for/);
    // The snippet does carry the computed origins, so it may still name them.
    expect(note).toContain("http://localhost:4000");
  });

  it("speaks in the future tense when the user declined the edit", () => {
    const [note] = correlationNotes("vite-spa", [], 1, "declined");
    expect(note).toMatch(
      /Add the API origin to that list in the snippet above/,
    );
  });

  it("says nothing when nothing was wired or nothing was re-read", () => {
    expect(correlationNotes("vite-spa", ORIGINS, 1, "withheld")).toEqual([]);
    expect(correlationNotes("vite-spa", ORIGINS, 1, "failed")).toEqual([]);
    expect(
      correlationNotes("vite-spa", ORIGINS, 1, "skipped-already-wired"),
    ).toEqual([]);
  });

  it("says nothing for recipes whose init has no correlation field", () => {
    // tauriInitSnippet() is `transportInstance` and nothing else; Flutter's Dart
    // init carries no origin list either.
    expect(correlationNotes("tauri", ORIGINS, 1, "wired")).toEqual([]);
    expect(correlationNotes("flutter", ORIGINS, 1, "wired")).toEqual([]);
  });

  it("still says nothing for a backend, which is the thing being called", () => {
    expect(correlationNotes("express", ORIGINS, 1, "wired")).toEqual([]);
  });
});

describe("a rejected ingest key is not a wired service", () => {
  const outcome = (over: Partial<ServiceOutcome>): ServiceOutcome => ({
    name: "web",
    relDir: "apps/web",
    recipe: "vite-spa",
    status: "wired",
    keyReady: true,
    filesTouched: [],
    notes: [],
    ...over,
  });

  const render = (outcomes: ServiceOutcome[]) => {
    const lines: string[] = [];
    printBatchSummary(
      { out: (s = "") => lines.push(s), err: () => {} },
      "https://api.example.com",
      "/repo",
      "proj_1",
      "kartbug",
      outcomes,
    );
    return lines;
  };

  it("marks it apart, keeps it out of the wired count, and says why on its row", () => {
    const lines = render([
      outcome({}),
      outcome({
        name: "api",
        relDir: "apps/api",
        recipe: "express",
        keyRejected: true,
        notes: ["This service will not report until that value is replaced."],
      }),
    ]);
    const text = lines.join("\n");
    const apiRow = lines.find((l) => l.includes("api  "))!;

    const g = glyphs();
    expect(apiRow).not.toContain(g.tick);
    expect(apiRow).toContain(g.warn);
    // Adjacent to the row, not only in the notes block at the bottom.
    expect(apiRow).toContain("wired, but its ingest key was rejected");
    expect(text).toContain("1 wired");
    expect(text).toContain("1 key rejected");
    // The probe's own sentence survives.
    expect(text).toContain(
      "api: This service will not report until that value is replaced.",
    );
    // And the run does not get to call itself complete.
    expect(text).toMatch(/Setup incomplete/);
  });

  it("leaves an accepted key counted and ticked", () => {
    const text = render([outcome({})]).join("\n");
    expect(text).toContain("1 wired");
    expect(text).not.toContain("key rejected");
    // Nothing is outstanding, so the bar is not "Setup incomplete" — but no
    // event arrived either (no sessionUrl on the outcome), and only a received
    // event may be called complete.
    expect(text).not.toMatch(/Setup incomplete/);
    expect(text).toMatch(/Wiring complete\. No event captured yet\./);
  });

  it("only calls itself complete once the event actually arrived", () => {
    const text = render([
      outcome({ sessionUrl: "https://app.example.com/sessions/s1" }),
    ]).join("\n");
    expect(text).toMatch(/Setup complete\. First event received\./);
  });

  it("counts the applications that reported when only some did", () => {
    const text = render([
      outcome({ sessionUrl: "https://app.example.com/sessions/s1" }),
      outcome({ name: "api", relDir: "apps/api", recipe: "express" }),
    ]).join("\n");
    expect(text).toMatch(
      /Wiring complete\. 1 of 2 applications have reported an event\./,
    );
    expect(text).not.toMatch(/Setup complete/);
  });
});
