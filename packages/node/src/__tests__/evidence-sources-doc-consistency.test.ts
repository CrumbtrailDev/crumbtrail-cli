import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_DESCRIPTOR,
  CLOUDWATCH_DESCRIPTOR,
  DATADOG_DESCRIPTOR,
  POSTHOG_DESCRIPTOR,
  SENTRY_DESCRIPTOR,
  SPLUNK_DESCRIPTOR,
} from "../evidence-sources";
import type { EvidenceSourceDescriptor } from "crumbtrail-core";

/**
 * BUG-18: docs/integrations/evidence-sources.md hand-authors a table of every
 * built-in evidence adapter (provider / lanes / join keys / doc link). It is
 * NOT code-generated the way docs/integrations/{README,sentry,datadog,splunk,
 * grafana-alloy,opentelemetry}.md are (see scripts/verify-integration-docs.mjs,
 * driven by packages/node/src/provider-recipes.ts) — that generator owns a
 * DIFFERENT list (the 5 OTLP dual-export recipes), not the 6 evidence
 * adapters, and running it with --write fully overwrites its docFiles. That is
 * exactly what silently deleted the hand-written "## Evidence adapter" section
 * from sentry.md/splunk.md/datadog.md in commit 224515d after 431a7c4 had
 * added it — see git log on those three files.
 *
 * Full codegen for evidence-sources.md isn't cheap to add here (it would mean
 * a new renderer in crumbtrail-node, which is out of scope for a docs-only
 * fix), so this is the lightweight substitute: assert the doc's table stays in
 * lockstep with the live descriptors this repo actually registers, and guard
 * the specific regression above (an evidence-adapter doc link must never point
 * at one of the codegen-owned provider-recipe docFiles, since that content
 * would be silently wiped the next time the recipe generator runs).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const integrationsDir = path.join(repoRoot, "docs", "integrations");
const docPath = path.join(integrationsDir, "evidence-sources.md");
const doc = fs.readFileSync(docPath, "utf8");

// The runtime descriptors, in the same order connector-routes.ts and the doc
// table list them (Sentry is the reference implementation, listed first).
const DESCRIPTORS: EvidenceSourceDescriptor[] = [
  SENTRY_DESCRIPTOR,
  CLOUDWATCH_DESCRIPTOR,
  SPLUNK_DESCRIPTOR,
  DATADOG_DESCRIPTOR,
  POSTHOG_DESCRIPTOR,
  CLOUDFLARE_DESCRIPTOR,
];

/** docFile names owned by scripts/verify-integration-docs.mjs (see
 *  packages/node/src/provider-recipes.json ids: datadog/otel/sentry/grafana/
 *  splunk). A `--write` run of that script fully overwrites these files, so an
 *  evidence-adapter doc link must never resolve to one of them. */
const CODEGEN_OWNED_DOC_FILES = new Set([
  "sentry.md",
  "datadog.md",
  "splunk.md",
  "opentelemetry.md",
  "grafana-alloy.md",
]);

interface TableRow {
  provider: string;
  lanes: string[];
  joinKeys: string[];
  docLink: string;
}

/** Parse the "## The adapters" markdown table into rows keyed by display name.
 *  Deliberately simple (split on `|`) — the table is hand-authored, not a
 *  format needing a real markdown parser. */
function parseAdapterTable(markdown: string): Map<string, TableRow> {
  const rows = new Map<string, TableRow>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    const [provider, lanesCell, joinKeysCell, docCell] = cells;
    if (provider === "Provider" || /^-+$/.test(provider)) continue; // header/divider
    const linkMatch = docCell.match(/\(\.\/([^)]+)\)/);
    if (!linkMatch) continue; // not an adapter row (e.g. a prose line starting with "|")
    rows.set(provider, {
      provider,
      lanes: lanesCell.split(",").map((s) => s.trim()),
      joinKeys: joinKeysCell.split(",").map((s) => s.trim()),
      docLink: linkMatch[1],
    });
  }
  return rows;
}

describe("docs/integrations/evidence-sources.md stays in lockstep with the registered adapters", () => {
  const table = parseAdapterTable(doc);

  it("has a table row for every descriptor actually registered in crumbtrail-node", () => {
    for (const d of DESCRIPTORS) {
      expect(
        table.has(d.displayName),
        `missing table row for ${d.displayName}`,
      ).toBe(true);
    }
    // And no extra rows for a provider that isn't actually registered.
    const registeredNames = new Set(DESCRIPTORS.map((d) => d.displayName));
    for (const name of table.keys()) {
      expect(
        registeredNames.has(name),
        `${name} has a doc row but no registered adapter`,
      ).toBe(true);
    }
  });

  it("lists each adapter's lanes and join keys exactly as the descriptor declares them", () => {
    for (const d of DESCRIPTORS) {
      const row = table.get(d.displayName);
      expect(row, `missing row for ${d.displayName}`).toBeDefined();
      if (!row) continue;
      expect(row.lanes, `${d.displayName} lanes drifted`).toEqual([...d.lanes]);
      expect(row.joinKeys, `${d.displayName} join keys drifted`).toEqual([
        ...d.joinKeys,
      ]);
    }
  });

  it("links each adapter doc to a file that exists on disk", () => {
    for (const d of DESCRIPTORS) {
      const row = table.get(d.displayName);
      if (!row) continue;
      const target = path.join(integrationsDir, row.docLink);
      expect(
        fs.existsSync(target),
        `${d.displayName} links to ${row.docLink}, which does not exist`,
      ).toBe(true);
    }
  });

  it("never links an evidence-adapter doc at a codegen-owned provider-recipe docFile (the exact drift that hit sentry/splunk/datadog once already)", () => {
    for (const d of DESCRIPTORS) {
      const row = table.get(d.displayName);
      if (!row) continue;
      expect(
        CODEGEN_OWNED_DOC_FILES.has(row.docLink),
        `${d.displayName}'s adapter doc link (${row.docLink}) points at a ` +
          "file scripts/verify-integration-docs.mjs regenerates from " +
          "provider-recipes.ts; that generator overwrites the whole file " +
          "and will silently delete any hand-written evidence-adapter " +
          "content placed there (as happened in commit 224515d) — link to " +
          "a dedicated, non-generated doc instead",
      ).toBe(false);
    }
  });

  it("every linked, non-codegen-owned adapter doc mentions each of the descriptor's env-var auth fields", () => {
    for (const d of DESCRIPTORS) {
      const row = table.get(d.displayName);
      if (!row) continue;
      if (CODEGEN_OWNED_DOC_FILES.has(row.docLink)) continue;
      const target = path.join(integrationsDir, row.docLink);
      if (!fs.existsSync(target)) continue; // reported by the earlier test
      const content = fs.readFileSync(target, "utf8");
      for (const authField of d.authFields) {
        expect(
          content.includes(authField),
          `${row.docLink} does not mention ${authField} (declared in ${d.provider}'s descriptor.authFields)`,
        ).toBe(true);
      }
    }
  });
});
