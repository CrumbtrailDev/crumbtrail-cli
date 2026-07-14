import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OTLP_CAPABILITY_FACTS,
  buildOtlpSnippets,
  otlpBearerHeaderValue,
} from "../index";

// The wizard guidance (buildOtlpSnippets, driven by OTLP_CAPABILITY_FACTS) and
// the collector recipes in packages/node/src/provider-recipes.json describe the
// SAME receiver. This test is the anti-drift gate agreed in the task card:
// compression none, no path suffix on the Crumbtrail endpoint, and the auth
// header names must agree across both surfaces.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providerRecipesPath = path.resolve(
  __dirname,
  "../../../node/src/provider-recipes.json",
);

interface ProviderRecipe {
  id: string;
  config: string;
  notes: string[];
}

function loadProviderRecipes(): ProviderRecipe[] {
  return JSON.parse(
    fs.readFileSync(providerRecipesPath, "utf-8"),
  ) as ProviderRecipe[];
}

/** Recipes that wire an `otlphttp/crumbtrail` (or Alloy) exporter block. */
function crumbtrailExporterRecipes(): ProviderRecipe[] {
  return loadProviderRecipes().filter((recipe) =>
    /otlphttp[./ ]?"?crumbtrail/.test(recipe.config),
  );
}

// Extract ONLY the Crumbtrail exporter block from a recipe config. The
// compression assertions must key off this block, not the whole file: a
// provider's *own* exporter (datadog/sentry/splunk/alloy sibling) may carry its
// own `compression:` line, and a whole-file grep would then false-pass a
// mis-set Crumbtrail block (a sibling's `compression: none` masks a Crumbtrail
// `compression: gzip`) — or false-fail on a sibling's `compression: gzip`.
// Two recipe shapes:
//   - YAML collector recipes: an `otlphttp/crumbtrail:` mapping key whose block
//     is its indentation-delimited children.
//   - Grafana Alloy (HCL): an `otelcol.exporter.otlphttp "crumbtrail" { ... }`
//     brace-delimited block.
const ALLOY_CRUMBTRAIL_ANCHOR = /otelcol\.exporter\.otlphttp\s+"crumbtrail"/;
const YAML_CRUMBTRAIL_ANCHOR = /^\s*otlphttp\/"?crumbtrail"?:\s*$/m;

function crumbtrailExporterBlock(config: string): string {
  if (ALLOY_CRUMBTRAIL_ANCHOR.test(config)) {
    return extractBraceBlock(config, ALLOY_CRUMBTRAIL_ANCHOR);
  }
  return extractYamlBlock(config, YAML_CRUMBTRAIL_ANCHOR);
}

/** Slice a brace-delimited `{ ... }` block starting at `anchor`. */
function extractBraceBlock(config: string, anchor: RegExp): string {
  const start = config.search(anchor);
  if (start === -1) {
    throw new Error("Crumbtrail Alloy exporter anchor not found");
  }
  const open = config.indexOf("{", start);
  if (open === -1) {
    throw new Error("Crumbtrail Alloy exporter block has no opening brace");
  }
  let depth = 0;
  for (let index = open; index < config.length; index += 1) {
    if (config[index] === "{") depth += 1;
    else if (config[index] === "}") {
      depth -= 1;
      if (depth === 0) return config.slice(start, index + 1);
    }
  }
  throw new Error("unterminated Crumbtrail Alloy exporter block");
}

/** Slice a YAML mapping block: the anchor line plus its more-indented children. */
function extractYamlBlock(config: string, anchor: RegExp): string {
  const lines = config.split("\n");
  const startIdx = lines.findIndex((line) => anchor.test(line));
  if (startIdx === -1) {
    throw new Error("otlphttp/crumbtrail exporter key not found");
  }
  const anchorIndent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
  const block = [lines[startIdx]];
  for (let index = startIdx + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // A blank line or a dedent to <= the anchor's indent ends the exporter's
    // block (the next sibling key or the `service:` section starts here).
    if (line.trim() === "") break;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= anchorIndent) break;
    block.push(line);
  }
  return block.join("\n");
}

const keys = { endpoint: "https://app.crumbtrail.com", apiKey: "bl_live_xyz" };

describe("OTLP capability facts", () => {
  it("buildOtlpSnippets reflects every capability fact", () => {
    const snippets = buildOtlpSnippets(keys);

    // Protocols: both http/protobuf and http/json.
    for (const protocol of OTLP_CAPABILITY_FACTS.protocols) {
      expect(snippets.env).toContain(protocol);
    }
    // Compression: recommended "none", surfaced as an env var.
    expect(snippets.env).toContain(
      `OTEL_EXPORTER_OTLP_COMPRESSION=${OTLP_CAPABILITY_FACTS.compression.recommended}`,
    );
    expect(OTLP_CAPABILITY_FACTS.compression.recommended).toBe("none");
    expect(OTLP_CAPABILITY_FACTS.compression.accepted).toContain("gzip");

    // Auth header names: X-Crumbtrail-Auth + Bearer, with the %20-escaped space.
    expect(snippets.authHeader).toContain("X-Crumbtrail-Auth=");
    expect(snippets.authHeader).toContain(otlpBearerHeaderValue(keys.apiKey));
    expect(snippets.authHeader).toContain("Bearer%20");
    // The previously-wrong unescaped space must NOT appear.
    expect(snippets.authHeader).not.toContain(`Bearer ${keys.apiKey}`);

    // Session attribute + appended paths.
    expect(snippets.sessionAttr).toContain(
      OTLP_CAPABILITY_FACTS.sessionAttribute,
    );
    for (const p of OTLP_CAPABILITY_FACTS.paths) {
      expect(snippets.note).toContain(p);
    }
    // The endpoint env var must NOT include a signal path suffix.
    expect(snippets.env).toContain(
      `OTEL_EXPORTER_OTLP_ENDPOINT=${keys.endpoint}`,
    );
    for (const p of OTLP_CAPABILITY_FACTS.paths) {
      expect(snippets.env).not.toContain(`${keys.endpoint}${p}`);
    }
  });

  it("has at least the four collector recipes wiring a Crumbtrail exporter", () => {
    const ids = crumbtrailExporterRecipes().map((r) => r.id);
    for (const expected of ["datadog", "sentry", "grafana", "splunk"]) {
      expect(ids).toContain(expected);
    }
  });

  it("every Crumbtrail exporter block agrees with the capability facts", () => {
    for (const recipe of crumbtrailExporterRecipes()) {
      // 1. compression is set to the recommended posture ("none") — scoped to
      //    the Crumbtrail exporter block so a *provider's* own compression line
      //    can neither mask a mis-set Crumbtrail block nor trip a false alarm.
      //    YAML recipes use `compression: none`; Alloy uses `compression = "none"`.
      const block = crumbtrailExporterBlock(recipe.config);
      const declaresCompressionNone =
        /compression:\s*none/.test(block) ||
        /compression\s*=\s*"none"/.test(block);
      expect(
        declaresCompressionNone,
        `recipe '${recipe.id}' must set compression to none on its Crumbtrail exporter`,
      ).toBe(true);
      // ...and the Crumbtrail block must carry NO other compression posture, so
      //    a Crumbtrail exporter set to gzip (or anything != none) fails loudly.
      const declaresOtherCompression =
        /compression:\s*(?!none\b)\S+/.test(block) ||
        /compression\s*=\s*"(?!none")[^"]+"/.test(block);
      expect(
        declaresOtherCompression,
        `recipe '${recipe.id}' must not set a non-none compression on its Crumbtrail exporter`,
      ).toBe(false);
      expect(block).toContain(OTLP_CAPABILITY_FACTS.compression.recommended);

      // 2. The Crumbtrail endpoint placeholder carries NO signal-path suffix —
      //    exporters append /v1/traces + /v1/logs themselves.
      expect(recipe.config).toContain("{{endpoint}}");
      for (const p of OTLP_CAPABILITY_FACTS.paths) {
        expect(recipe.config).not.toContain(`{{endpoint}}${p}`);
      }
    }
  });

  it("does not reference an invented Sentry auth header", () => {
    const sentry = loadProviderRecipes().find((r) => r.id === "sentry");
    expect(sentry).toBeDefined();
    // The fabricated `sentry-trace-token` header was dropped in favor of an
    // honest, deployment-specific note.
    expect(sentry?.config).not.toContain("sentry-trace-token");
    expect(sentry?.notes.join(" ").toLowerCase()).toContain(
      "deployment-specific",
    );
  });
});
