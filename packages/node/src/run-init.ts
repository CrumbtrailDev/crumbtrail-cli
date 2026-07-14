import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildInitPlan,
  detectPackageManager,
  type InitPlan,
  type PackageJsonLike,
} from "./init-plan";

export interface ApplyInitResult {
  wrote: string[];
  skipped: string[];
  gitignoreUpdated: boolean;
  configWritten: boolean;
}

function writeFileIfAllowed(
  filePath: string,
  contents: string,
  force: boolean,
  result: ApplyInitResult,
): void {
  if (fs.existsSync(filePath) && !force) {
    result.skipped.push(filePath);
    return;
  }
  fs.writeFileSync(filePath, contents);
  result.wrote.push(filePath);
}

function ensureGitignoreEntry(cwd: string, entry: string): boolean {
  const gitignorePath = path.join(cwd, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf-8");
    const present = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === entry);
    if (present) return false;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  return true;
}

/** Write the planned config, helper files, and gitignore entry to disk. Idempotent. */
export function applyInitPlan(
  plan: InitPlan,
  opts: { force?: boolean } = {},
): ApplyInitResult {
  const force = opts.force ?? false;
  const result: ApplyInitResult = {
    wrote: [],
    skipped: [],
    gitignoreUpdated: false,
    configWritten: false,
  };
  const cwd = path.dirname(plan.configPath);

  fs.mkdirSync(cwd, { recursive: true });

  if (!fs.existsSync(plan.configPath) || force) {
    fs.writeFileSync(
      plan.configPath,
      `${JSON.stringify(plan.config, null, 2)}\n`,
    );
    result.configWritten = true;
    result.wrote.push(plan.configPath);
  } else {
    result.skipped.push(plan.configPath);
  }

  for (const file of plan.files) {
    writeFileIfAllowed(file.path, file.contents, force, result);
  }

  result.gitignoreUpdated = ensureGitignoreEntry(cwd, plan.gitignoreEntry);

  return result;
}

export interface RunInitInput {
  cwd: string;
  force?: boolean;
  install?: boolean;
  port?: number;
}

export interface RunInitResult {
  plan: InitPlan;
  applied: ApplyInitResult;
  installRan: boolean;
  installOk: boolean;
}

function readPackageJson(cwd: string): PackageJsonLike {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJsonLike;
  } catch {
    return {};
  }
}

/** Full `crumbtrail-server init`: detect, plan, write files, and (optionally) install deps. */
export function runInit(input: RunInitInput): RunInitResult {
  const pkg = readPackageJson(input.cwd);
  const packageManager = detectPackageManager(input.cwd);
  const plan = buildInitPlan({
    cwd: input.cwd,
    pkg,
    packageManager,
    port: input.port,
    env: process.env,
  });
  const applied = applyInitPlan(plan, { force: input.force });

  let installRan = false;
  let installOk = false;
  if (input.install !== false) {
    const [cmd, ...args] = plan.installCommand.split(" ");
    const proc = spawnSync(cmd, args, { cwd: input.cwd, stdio: "inherit" });
    installRan = true;
    installOk = proc.status === 0;
  }

  return { plan, applied, installRan, installOk };
}
