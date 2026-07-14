import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSessionDirById } from "../session-paths";

describe("resolveSessionDirById", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sp-"));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("resolves a bare id living in the finalized partition layout", () => {
    const id = "ses_123";
    const partDir = path.join(outputDir, "acme", "shop", "2026-06-30", id);
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, "meta.json"), JSON.stringify({ id }));

    expect(resolveSessionDirById(id, outputDir)).toBe(partDir);
  });

  it("resolves a bare id in the flat outputDir/id layout", () => {
    const id = "ses_flat";
    const dir = path.join(outputDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id }));

    expect(resolveSessionDirById(id, outputDir)).toBe(dir);
  });

  it("returns a direct session directory path unchanged", () => {
    const dir = path.join(outputDir, "anywhere");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}");

    expect(resolveSessionDirById(dir)).toBe(dir);
  });

  it("falls back to the flat path for a missing session", () => {
    expect(resolveSessionDirById("nope", outputDir)).toBe(
      path.join(outputDir, "nope"),
    );
  });

  it("does not resolve a partition entry whose basename differs from the id", () => {
    const partDir = path.join(
      outputDir,
      "acme",
      "shop",
      "2026-06-30",
      "ses_other",
    );
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(
      path.join(partDir, "meta.json"),
      JSON.stringify({ id: "ses_other" }),
    );

    // Requesting a different id must not return ses_other; falls back to the flat path.
    expect(resolveSessionDirById("ses_wanted", outputDir)).toBe(
      path.join(outputDir, "ses_wanted"),
    );
  });
});
