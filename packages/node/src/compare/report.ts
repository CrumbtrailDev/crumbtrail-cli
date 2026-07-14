import type {
  Divergence,
  EnvChannelDelta,
  EnvDiff,
  SessionComparison,
} from "./index";

type SessionRef = SessionComparison["a"];

const PLANE_ORDER = ["flow", "network", "db", "env"] as const;
const PLANE_LABELS: Record<Divergence["plane"], string> = {
  flow: "Flow steps",
  network: "Network calls",
  db: "Database rows",
  env: "Environment and flags",
};

export function renderCompareReport(comparison: SessionComparison): string {
  const lines: string[] = [];
  const regressed = comparison.verdict === "regression";

  lines.push(
    `# Session comparison - ${formatSessionRef(comparison.a)} vs ${formatSessionRef(comparison.b)}`,
  );
  lines.push("");
  lines.push(
    regressed
      ? `> **Verdict: REGRESSION** (confidence: ${comparison.confidence}) - recorded behavior changed between these sessions.`
      : `> **Verdict: CLEAN** (confidence: ${comparison.confidence}) - the recorded sessions show no behavioral divergence.`,
  );
  lines.push("");
  lines.push(
    "A is the baseline session; B is the candidate release/build. Every row below is grounded in the recorded evidence of both sessions.",
  );
  lines.push("");
  lines.push("## Aligned flow");
  lines.push("");
  const { matchedSteps, unmatchedA, unmatchedB } = comparison.alignment;
  lines.push(
    `${matchedSteps} step(s) matched by component identity · ${unmatchedA} only in A · ${unmatchedB} only in B`,
  );
  lines.push("");

  if (comparison.divergences.length > 0) {
    lines.push("| Plane | Kind | Component | Divergence |");
    lines.push("|---|---|---|---|");
    for (const d of comparison.divergences) {
      const component = d.sig ? `\`${escapeCell(d.sig)}\`` : "—";
      lines.push(
        `| **${d.plane}** | \`${d.kind}\` | ${component} | ${escapeCell(d.brief)} |`,
      );
    }
    lines.push("");
  }

  for (const plane of PLANE_ORDER) {
    const planeDivergences = comparison.divergences.filter(
      (d) => d.plane === plane,
    );
    if (planeDivergences.length === 0) continue;
    lines.push(`## ${PLANE_LABELS[plane]}`);
    lines.push("");
    for (const d of planeDivergences) {
      lines.push(`### \`${d.kind}\` - ${escapeCell(d.brief)}`);
      lines.push("");
      if (d.sig) lines.push(`- Component: \`${d.sig}\``);
      if (d.requestId) lines.push(`- Request: \`${d.requestId}\``);
      if (d.table)
        lines.push(
          `- Table: \`${d.table}\`${d.pk ? ` · pk \`${JSON.stringify(d.pk)}\`` : ""}`,
        );
      lines.push("");
      if (d.envDelta) {
        lines.push(...renderEnvDelta(d.envDelta));
      } else {
        lines.push("```diff");
        lines.push(`- before: ${JSON.stringify(d.before)}`);
        lines.push(`+ after:  ${JSON.stringify(d.after)}`);
        lines.push("```");
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    comparison.noise.suppressedCount > 0
      ? `*${comparison.noise.suppressedCount} expected-variance difference(s) suppressed by the noise model (${comparison.noise.rules.join(", ")}).*`
      : "*No differences were suppressed by the noise model.*",
  );
  lines.push("");
  return lines.join("\n");
}

export function formatComparisonSummary(comparison: SessionComparison): string {
  const lines: string[] = [];
  lines.push(
    `crumbtrail-server compare - ${formatSessionRef(comparison.a)} vs ${formatSessionRef(comparison.b)}`,
  );
  lines.push(`  Schema:      ${comparison.schemaVersion}`);
  lines.push(
    `  Verdict:     ${comparison.verdict.toUpperCase()} (confidence ${comparison.confidence})`,
  );
  lines.push(
    `  Alignment:   ${comparison.alignment.matchedSteps} matched · ${comparison.alignment.unmatchedA} only in A · ${comparison.alignment.unmatchedB} only in B`,
  );
  lines.push(`  Divergences: ${comparison.divergences.length}`);
  for (const d of comparison.divergences.slice(0, 5)) {
    lines.push(`    [${d.plane}] ${d.kind} - ${d.brief}`);
  }
  if (comparison.divergences.length > 5) {
    lines.push(
      `    ... and ${comparison.divergences.length - 5} more (use --json or --report for the complete list)`,
    );
  }
  const rules =
    comparison.noise.rules.length > 0
      ? ` (${comparison.noise.rules.join(", ")})`
      : "";
  lines.push(
    `  Noise:       ${comparison.noise.suppressedCount} suppressed${rules}`,
  );
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Short, release-first label for a session: the release tag when one exists
 * (e.g. "R181"), otherwise the bare session id. Used to build "R181 vs R182"
 * comparison titles. Exported so the regression witness reuses one convention.
 */
export function sessionRefLabel(ref: SessionRef): string {
  return ref.release ?? ref.sessionId;
}

/** "R181 vs R182" when releases exist, else falls back to bare session ids. */
export function comparisonTitle(comparison: SessionComparison): string {
  return `${sessionRefLabel(comparison.a)} vs ${sessionRefLabel(comparison.b)}`;
}

/**
 * Verbose reference for report headers. Leads with the release when present so
 * the comparison reads "R181 vs R182" rather than opaque session ids, while
 * keeping the session id and build for traceability.
 */
/**
 * Renders the structured env delta as an added/removed/changed diff block so an
 * agent (or human) can read "which flag/config/release flipped" directly,
 * instead of eyeballing two opaque JSON blobs.
 */
function renderEnvDelta(delta: EnvDiff): string[] {
  const lines: string[] = ["```diff"];
  renderEnvChannel(lines, "flags", delta.flags);
  renderEnvChannel(lines, "config", delta.config);
  if (delta.release) {
    lines.push(
      `~ release: ${JSON.stringify(delta.release.before ?? null)} -> ${JSON.stringify(delta.release.after ?? null)}`,
    );
  }
  if (delta.build) {
    lines.push(
      `~ build: ${JSON.stringify(delta.build.before ?? null)} -> ${JSON.stringify(delta.build.after ?? null)}`,
    );
  }
  if (lines.length === 1) lines.push("  (no field-level changes)");
  lines.push("```");
  return lines;
}

function renderEnvChannel(
  lines: string[],
  channel: string,
  delta: EnvChannelDelta,
): void {
  for (const change of delta.added) {
    lines.push(
      `+ ${channel}.${change.key}: ${JSON.stringify(change.after ?? null)}`,
    );
  }
  for (const change of delta.removed) {
    lines.push(
      `- ${channel}.${change.key}: ${JSON.stringify(change.before ?? null)}`,
    );
  }
  for (const change of delta.changed) {
    lines.push(
      `~ ${channel}.${change.key}: ${JSON.stringify(change.before ?? null)} -> ${JSON.stringify(change.after ?? null)}`,
    );
  }
}

function formatSessionRef(ref: SessionRef): string {
  if (ref.release) {
    const detail = [
      `session ${ref.sessionId}`,
      ref.build ? `build ${ref.build}` : undefined,
    ].filter(Boolean);
    return `${ref.release} (${detail.join(", ")})`;
  }
  return ref.build ? `${ref.sessionId} (build ${ref.build})` : ref.sessionId;
}
