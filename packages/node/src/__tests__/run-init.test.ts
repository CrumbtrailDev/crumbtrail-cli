import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInitPlan } from "../init-plan";
import { applyInitPlan } from "../run-init";

const tempPaths: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-applyinit-"));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("applyInitPlan", () => {
  it("writes the config and helper files and records what it wrote", () => {
    const dir = makeTempDir();
    const plan = buildInitPlan({
      cwd: dir,
      pkg: { dependencies: { express: "^4" } },
      packageManager: "pnpm",
    });

    const result = applyInitPlan(plan);

    expect(result.configWritten).toBe(true);
    expect(fs.existsSync(plan.configPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, "crumbtrail.client.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "crumbtrail.server.js"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(plan.configPath, "utf-8")).port).toBe(
      9898,
    );
  });

  it("adds the gitignore entry once and does not duplicate it", () => {
    const dir = makeTempDir();
    const plan = buildInitPlan({ cwd: dir, pkg: {}, packageManager: "npm" });

    applyInitPlan(plan);
    applyInitPlan(plan);

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    const occurrences = gitignore
      .split("\n")
      .filter((line) => line.trim() === ".crumbtrail/").length;
    expect(occurrences).toBe(1);
  });

  it("does not overwrite existing helper files unless forced", () => {
    const dir = makeTempDir();
    const plan = buildInitPlan({ cwd: dir, pkg: {}, packageManager: "npm" });
    const clientPath = path.join(dir, "crumbtrail.client.js");
    fs.writeFileSync(clientPath, "// user edited");

    const result = applyInitPlan(plan);
    expect(fs.readFileSync(clientPath, "utf-8")).toBe("// user edited");
    expect(result.skipped).toContain(clientPath);

    const forced = applyInitPlan(plan, { force: true });
    expect(fs.readFileSync(clientPath, "utf-8")).toContain("Crumbtrail.init");
    expect(forced.wrote).toContain(clientPath);
  });
});
