import type { CapsuleV2, Symptom } from "crumbtrail-core";
import { defaultCliConfig } from "./config";
import { resolveIssueToCapsule } from "./capsule-resolve";
import { evidenceSourcesFromEnv } from "./evidence-sources";
import { buildRecallStore } from "./recall";

/** Flags whose next argv entry is a value, not the positional symptom title. */
const VALUE_FLAGS = [
  "--output",
  "--title",
  "--description",
  "--url",
  "--release",
  "--error-sig",
  "--source",
];

function stringFlag(rest: string[], name: string): string | undefined {
  const idx = rest.indexOf(name);
  if (idx < 0) return undefined;
  const value = rest[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * `crumbtrail-server capsule <symptom title>` — resolve an issue to the
 * capsule.v2 envelope.
 *
 * Runs the SAME shared resolution helper the MCP `resolveCapsule` tool runs
 * ({@link resolveIssueToCapsule}: the existing locate + assemble path, then the
 * one capsule compile site), so the CLI and MCP surfaces are at parity by
 * construction. Default output is a human summary; `--json` emits the raw
 * capsule.v2 envelope.
 */
export async function runCapsule(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const outputDir = stringFlag(rest, "--output") ?? defaultCliConfig().output;
  const positional = rest.find(
    (arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1]),
  );
  const title = stringFlag(rest, "--title") ?? positional;

  if (!title) {
    process.stderr.write(
      "crumbtrail-server capsule: a symptom title is required (pass it positionally or with --title).\n",
    );
    return 1;
  }

  const symptom: Symptom = {
    title,
    ...optional("description", stringFlag(rest, "--description")),
    ...optional("url", stringFlag(rest, "--url")),
    ...optional("release", stringFlag(rest, "--release")),
    ...optional("errorSig", stringFlag(rest, "--error-sig")),
    ...optional("source", stringFlag(rest, "--source")),
  };

  const { capsule } = await resolveIssueToCapsule(
    symptom,
    buildRecallStore(outputDir),
    { sources: evidenceSourcesFromEnv() },
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(capsule, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCapsule(capsule)}\n`);
  }
  return 0;
}

function optional<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

/** Human summary of a capsule.v2 envelope. States its limits honestly: an
 *  inconclusive advisory and an absent completeness score are shown as such,
 *  never smoothed over. */
export function formatCapsule(capsule: CapsuleV2): string {
  const lines: string[] = [];
  lines.push(
    `crumbtrail-server capsule — ${capsule.identity.canonicalId} (${capsule.schemaVersion})`,
  );
  lines.push(`  Signature:   ${capsule.identity.signature}`);
  lines.push(`  Revision:    ${capsule.identity.revision}`);
  lines.push(`  Symptom:     ${capsule.symptom.behavior.title || "(none given)"}`);
  lines.push(
    `  Evidence:    ${capsule.evidence.bundle.evidence.length} item(s) in ${capsule.evidence.bundle.schemaVersion}` +
      ` · lanes ${capsule.quality.presentLanes.join(", ") || "none"}`,
  );
  lines.push(
    `  Join graph:  ${capsule.joinGraph.edges.length} edge(s), ${capsule.joinGraph.islands.length} unjoined island(s)`,
  );
  lines.push(
    `  Completeness: ${
      capsule.quality.completeness
        ? `${capsule.quality.completeness.present}/${capsule.quality.completeness.expected} expected lanes`
        : "not scored (no evidence profile configured)"
    }`,
  );
  lines.push(
    `  Gaps:        ${capsule.quality.gaps.length === 0 ? "none" : capsule.quality.gaps.map((g) => `${g.lane}:${g.reason}`).join(", ")}`,
  );
  const top = capsule.advisory.fixClasses[0];
  lines.push(
    `  Advisory:    ${
      capsule.advisory.inconclusive
        ? "inconclusive"
        : `${top?.kind} (confidence ${top?.confidence})`
    }`,
  );
  lines.push(
    `  Resolution:  ${capsule.resolution.verificationState}${capsule.resolution.linkedFix ? ` · ${capsule.resolution.linkedFix}` : ""}`,
  );
  for (const action of capsule.directions.nextActions.slice(0, 3)) {
    lines.push(`    → ${action}`);
  }
  return lines.join("\n");
}
