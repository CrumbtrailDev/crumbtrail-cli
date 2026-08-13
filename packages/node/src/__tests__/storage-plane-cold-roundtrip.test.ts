import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  COLD_EVENTS_ARTIFACT,
  SIGNATURES_ARTIFACT,
  readColdEvents,
  writeColdEvidenceArtifacts,
} from "../storage-plane";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-roundtrip-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function clickOn(t: number, el: Record<string, unknown>): BugEvent {
  return { t, k: "clk", d: { el } } as unknown as BugEvent;
}

function elementOf(event: BugEvent | undefined): Record<string, unknown> {
  const data = (event as unknown as { d?: Record<string, unknown> } | undefined)
    ?.d;
  const el = data?.el;
  return el && typeof el === "object" ? (el as Record<string, unknown>) : {};
}

function coldLines(): string[] {
  return zlib
    .zstdDecompressSync(fs.readFileSync(path.join(dir, COLD_EVENTS_ARTIFACT)))
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

describe("cold round trip preserves element identity", () => {
  it("returns the descriptive fields a reader needs to name the element", async () => {
    const events = [
      clickOn(1000, {
        tag: "A",
        id: "checkout",
        txt: "Continue",
        href: "https://shop.example.test/step/2",
        name: "next",
        sig: "sg_one",
        path: "div[id=root]>nav:nth-of-type(1)>a:nth-of-type(1)",
      }),
    ];

    await writeColdEvidenceArtifacts({ sessionDir: dir, events });
    const back = readColdEvents(dir);

    expect(back).toHaveLength(1);
    expect(elementOf(back?.[0])).toMatchObject({
      tag: "A",
      id: "checkout",
      txt: "Continue",
      href: "https://shop.example.test/step/2",
      name: "next",
      sig: "sg_one",
      path: "div[id=root]>nav:nth-of-type(1)>a:nth-of-type(1)",
    });
  });

  it("keeps two different elements distinguishable after the round trip", async () => {
    const events = [
      clickOn(1000, { tag: "BUTTON", txt: "First", sig: "sg_a", path: "p>a" }),
      clickOn(1100, { tag: "BUTTON", txt: "Second", sig: "sg_b", path: "p>b" }),
      clickOn(1200, { tag: "BUTTON", txt: "First", sig: "sg_a", path: "p>a" }),
      clickOn(1300, { tag: "BUTTON", txt: "Second", sig: "sg_b", path: "p>b" }),
    ];

    await writeColdEvidenceArtifacts({ sessionDir: dir, events });
    const back = readColdEvents(dir) ?? [];

    const labels = back.map((event) => elementOf(event).txt);
    expect(labels).toEqual(["First", "Second", "First", "Second"]);
    expect(new Set(labels).size).toBe(2);
  });

  // The design decision this file exists to pin down: a descriptive field that
  // differs between two events sharing one signature must come back per event.
  // Replaying a first-seen value onto every event would fabricate evidence.
  it("never replays one event's text onto another that carried different text", async () => {
    const events = [
      clickOn(1000, { tag: "BUTTON", txt: "Add to cart", sig: "sg_x", path: "p>x" }),
      clickOn(1500, { tag: "BUTTON", txt: "Adding...", sig: "sg_x", path: "p>x" }),
      clickOn(2000, { tag: "BUTTON", txt: "Added", sig: "sg_x", path: "p>x" }),
    ];

    await writeColdEvidenceArtifacts({ sessionDir: dir, events });
    const back = readColdEvents(dir) ?? [];

    expect(back.map((event) => elementOf(event).txt)).toEqual([
      "Add to cart",
      "Adding...",
      "Added",
    ]);
    // The field that DID agree everywhere is still hoisted, so the size win for
    // repeated structure is not given up to buy the varying field back.
    const dictionary: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, SIGNATURES_ARTIFACT), "utf-8"),
    );
    const entry = (dictionary as { entries: Array<Record<string, unknown>> })
      .entries[0];
    expect(entry.path).toBe("p>x");
    expect(entry.tag).toBe("BUTTON");
    // The varying field is the ONLY one that was not hoisted.
    expect(entry.desc).toBeUndefined();
    for (const line of coldLines()) expect(line).not.toContain('"tag"');
  });

  it("does not widen what escapes masking", async () => {
    const events = [
      clickOn(1000, {
        tag: "INPUT",
        txt: "******",
        password: "hunter2-not-a-real-secret",
        sig: "sg_m",
        path: "p>m",
      }),
    ];

    await writeColdEvidenceArtifacts({ sessionDir: dir, events });

    const onDisk =
      coldLines().join("\n") +
      fs.readFileSync(path.join(dir, SIGNATURES_ARTIFACT), "utf-8");
    expect(onDisk).not.toContain("hunter2-not-a-real-secret");

    const el = elementOf(readColdEvents(dir)?.[0]);
    expect(el.txt).toBe("******");
    expect(el.password).toBe("[REDACTED]");
  });

  it("reads a dictionary written before descriptors were stored", () => {
    // The exact shape already on disk for finalized sessions: entries with no
    // `desc`, and cold events whose `d.el` is nothing but the ref.
    fs.writeFileSync(
      path.join(dir, SIGNATURES_ARTIFACT),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: 1,
            sig: "sg_legacy",
            path: "p>legacy",
            tag: "BUTTON",
            firstSeen: 1000,
            firstEventKind: "clk",
          },
        ],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(dir, COLD_EVENTS_ARTIFACT),
      zlib.zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({ t: 1000, k: "clk", d: { el: { sigRef: 1 } } })}\n` +
            `${JSON.stringify({ t: 1100, k: "clk", d: { el: { sigRef: 9 } } })}\n`,
          "utf-8",
        ),
      ),
    );

    const back = readColdEvents(dir) ?? [];

    expect(back).toHaveLength(2);
    // Restored to exactly what the old reader produced — no invented text.
    expect(elementOf(back[0])).toEqual({
      sig: "sg_legacy",
      path: "p>legacy",
      tag: "BUTTON",
    });
    // A dangling ref with nothing else on it still drops the element entirely.
    expect(
      (back[1] as unknown as { d: Record<string, unknown> }).d,
    ).not.toHaveProperty("el");
  });
});
