import type { CapsuleV2, Symptom } from "crumbtrail-core";
import { defaultCliConfig } from "./config";
import { resolveTicketToCapsule } from "./capsule-resolve";
import { evidenceSourcesFromEnv } from "./evidence-sources";
import { buildRecallStore } from "./recall";
import { localSessionAccess } from "./ticket-resolve";

/** Flags whose next argv entry is a value, not the positional symptom title. */
const VALUE_FLAGS = [
  "--output",
  "--title",
  "--description",
  "--url",
  "--release",
  "--error-sig",
  "--source",
  "--ticket",
  "--provider",
  "--baseline",
  "--current",
  "--repo",
  "--base-ref",
  "--head-ref",
];

const TICKET_PROVIDERS = ["jira", "zendesk", "trello"];

function stringFlag(rest: string[], name: string): string | undefined {
  const idx = rest.indexOf(name);
  if (idx < 0) return undefined;
  const value = rest[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * `crumbtrail-server capsule <symptom title | --ticket ref>` — resolve an issue
 * to the capsule.v2 envelope.
 *
 * Runs the SAME shared resolution helper the MCP `resolveCapsule` tool runs
 * ({@link resolveTicketToCapsule}: the one ticket → bundle producer `solveContext`
 * uses, then the one capsule compile site), so the CLI and MCP surfaces are at
 * parity by construction for both the ticket and the symptom input. Default
 * output is a human summary; `--json` emits the raw capsule.v2 envelope.
 */
export async function runCapsule(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const outputDir = stringFlag(rest, "--output") ?? defaultCliConfig().output;
  const positional = rest.find(
    (arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1]),
  );
  const title = stringFlag(rest, "--title") ?? positional;
  const ticket = stringFlag(rest, "--ticket");
  const provider = stringFlag(rest, "--provider");

  if (!title && !ticket) {
    process.stderr.write(
      "crumbtrail-server capsule: a symptom title or --ticket reference is required (pass the title positionally or with --title).\n",
    );
    return 1;
  }

  if (provider && !TICKET_PROVIDERS.includes(provider)) {
    process.stderr.write(
      `crumbtrail-server capsule: --provider must be one of ${TICKET_PROVIDERS.join(", ")}.\n`,
    );
    return 1;
  }

  const symptom: Symptom | undefined = title
    ? {
        title,
        ...optional("description", stringFlag(rest, "--description")),
        ...optional("url", stringFlag(rest, "--url")),
        ...optional("release", stringFlag(rest, "--release")),
        ...optional("errorSig", stringFlag(rest, "--error-sig")),
        ...optional("source", stringFlag(rest, "--source")),
      }
    : undefined;

  const repo = stringFlag(rest, "--repo");
  const [owner, repoName] = repo ? repo.split("/") : [];
  const baseRef = stringFlag(rest, "--base-ref");
  const headRef = stringFlag(rest, "--head-ref");

  // The SAME argument record the MCP tools receive, so one producer sees one
  // input shape no matter which surface asked.
  const args: Record<string, unknown> = {
    ...(symptom ? { symptom } : {}),
    // With --provider this is the explicit { provider, ticketKey } form;
    // without it, a pasted ticket URL the producer recognizes locally.
    ...(ticket ? { ticket: provider ? { provider, ticketKey: ticket } : ticket } : {}),
    ...optional("baselineSession", stringFlag(rest, "--baseline")),
    ...optional("currentSession", stringFlag(rest, "--current")),
    ...(owner && repoName && baseRef && headRef
      ? { gitHost: { owner, repo: repoName, baseRef, headRef } }
      : {}),
  };

  const resolved = await resolveTicketToCapsule(args, {
    recallStore: buildRecallStore(outputDir),
    evidenceSources: evidenceSourcesFromEnv(),
    localSessions: localSessionAccess(outputDir),
    surface: "capsule",
  });

  if (resolved.kind === "error") {
    process.stderr.write(`crumbtrail-server capsule: ${resolved.message}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(resolved.capsule, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCapsule(resolved.capsule)}\n`);
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
  if (capsule.identity.externalRefs.length > 0) {
    lines.push(
      `  Ticket:      ${capsule.identity.externalRefs
        .map((ref) => `${ref.system}:${ref.id}`)
        .join(", ")}`,
    );
  }
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
