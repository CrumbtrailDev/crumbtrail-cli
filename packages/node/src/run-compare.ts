import fs from "node:fs";
import path from "node:path";
import { defaultCliConfig } from "./config";
import {
  compareSessions,
  CompareError,
  type SessionComparison,
} from "./compare";
import { formatComparisonSummary, renderCompareReport } from "./compare/report";
import { resolveSessionDirById } from "./session-paths";

interface CompareCliOptions {
  a?: string;
  b?: string;
  json: boolean;
  outputDir: string;
  reportPath?: string;
}

export async function runCompare(rest: string[]): Promise<number> {
  const options = parseCompareArgs(rest);
  if (!options.a || !options.b) {
    process.stderr.write(
      "crumbtrail-server compare: two session ids or directories are required.\n",
    );
    return 1;
  }

  let comparison: SessionComparison;
  try {
    comparison = await compareSessions(
      resolveTarget(options.a, options.outputDir),
      resolveTarget(options.b, options.outputDir),
    );
  } catch (err) {
    if (err instanceof CompareError) {
      process.stderr.write(`crumbtrail-server compare: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (options.reportPath) {
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    fs.writeFileSync(options.reportPath, renderCompareReport(comparison));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatComparisonSummary(comparison)}\n`);
    if (options.reportPath)
      process.stdout.write(`  Report:      ${options.reportPath}\n`);
  }
  return 0;
}

function parseCompareArgs(rest: string[]): CompareCliOptions {
  const positionals: string[] = [];
  const options: CompareCliOptions = {
    json: rest.includes("--json"),
    outputDir: defaultCliConfig().output,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") continue;
    if (arg === "--output") {
      if (rest[index + 1]) options.outputDir = rest[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--report") {
      if (rest[index + 1]) options.reportPath = path.resolve(rest[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positionals.push(arg);
  }

  options.a = positionals[0];
  options.b = positionals[1];
  return options;
}

function resolveTarget(target: string, outputDir: string): string {
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target === "." ||
    target.startsWith(".")
  ) {
    return path.resolve(target);
  }
  return resolveSessionDirById(target, outputDir);
}
