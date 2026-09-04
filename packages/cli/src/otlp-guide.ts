// The OTLP guide file written for non-JS services (rails/django/go/dotnet/…).
//
// The CLI cannot inject code into a Ruby or Python service, but it can still do
// the valuable half automatically: provision the service, mint its key, and
// leave a filled-in setup guide in the service directory. `buildPlan` already
// produces an `otlp-guidance` Plan carrying the snippet + agent prompt with the
// real endpoint and key threaded through (inject/recipes.ts planOtlp) — this
// module only renders that into a file body and re-wraps it as a `create` Plan,
// so the existing executor supplies refuse-to-overwrite and rollback and no
// change to executor.ts is needed.

import path from "node:path";
import { DOTNET_STRUCTURED_BODY_SOURCE } from "./dotnet-body-capture";
import type { Stack } from "crumbtrail-core";
import { OTLP_GUIDE_FILENAME } from "./otlp";
import type { Plan } from "./inject";

export { OTLP_GUIDE_FILENAME } from "./otlp";

export interface OtlpGuideInput {
  stack: Stack;
  serviceName: string;
  endpoint: string;
  /** plan.snippet — the OTLP env/header/attribute block, key already filled in. */
  snippet: string;
  /** plan.agentPrompt — the ready-to-paste prompt for a coding agent. */
  agentPrompt: string;
  /**
   * Where the reader mints the key this guide's snippet only has a placeholder
   * for (the project scoped /setup page). Omitted only when the caller has no
   * project to point at.
   */
  mintUrl?: string;
  /**
   * The literal the snippet carries where the key goes, so the guide can name
   * the exact string to replace.
   */
  keyPlaceholder?: string;
}

export function renderOtlpGuide(input: OtlpGuideInput): string {
  // The guide used to open with "this service is already provisioned and has
  // its own ingest key". Only the first half was ever true: planOtlp fills the
  // snippet with a placeholder on purpose (it mints nothing, so a rerun leaves
  // no unused live credentials behind), and there is no per service key at all
  // because one key covers the whole project. A reader who believed the old
  // sentence went looking for a secret that did not exist, and could not
  // configure the exporter until they stopped believing it.
  const placeholder = input.keyPlaceholder ?? "<your-ingest-key>";
  const mint = input.mintUrl
    ? `Mint one at ${input.mintUrl} and paste it in.`
    : "Mint one on the Setup page of your Crumbtrail dashboard and paste it in.";
  return [
    `# Crumbtrail: ${input.serviceName}`,
    "",
    `Detected stack: **${input.stack}**`,
    `Ingest endpoint: ${input.endpoint}`,
    "",
    `This application is provisioned in Crumbtrail. No ingest key was minted for`,
    `it, so the snippet below carries \`${placeholder}\` where the key goes.`,
    `${mint} One key covers the whole project, so the same value works for every`,
    `application in it.`,
    "",
    `There is no SDK to install: ${input.stack} speaks OpenTelemetry, so Crumbtrail`,
    `accepts its traces directly. Everything below is the one manual step.`,
    "",
    "## 1. Configure the OTLP exporter",
    "",
    "```sh",
    input.snippet,
    "```",
    "",
    "## 2. Or hand this to a coding agent",
    "",
    "```",
    input.agentPrompt,
    "```",
    "",
    ...(input.stack === "dotnet" ? [
      "## Optional JSON request evidence",
      "",
      "OTLP traces do not capture JSON operands. Native body capture remains a manual integration.",
      "Save the following source as StructuredBody.cs in your API project. It requires .NET 9.",
      "Call StructuredBody.Capture on at most 16385 UTF8 bytes before queuing evidence.",
      "Pass truncated: true when the read limit was exceeded. Do not capture authentication routes.",
      "Emit result.Body as body on backend.req.start or responseBody on backend.req.end,",
      "result.State as requestBodyState or responseBodyState, and result.Redaction as redaction.",
      "Send the native events envelope to /api/events with the project ingest key as a Bearer header.",
      "Use the browser session and request correlation headers and the actual service name.",
      "Buffer and rewind requests and tee responses without changing application bytes.",
      "Queue delivery outside the request and bound retries. Missing correlation means no capture.",
      "",
      "The backend policy retains safe numbers, booleans, null, short lowercase enums,",
      "three uppercase letter units and digit identifiers up to twelve digits.",
      "It removes sensitive named fields, card shaped numbers, unsafe integers and other strings.",
      "UUIDs, free text and dates are withheld by this narrower profile. Do not infer identity from names.",
      "Duplicate keys and invalid JSON are invalid. Oversized bodies are truncated and omitted.",
      "The cloud reclassifies every declared body using its canonical structured classifier.",
      "A policy declaration never grants permission to store a value. Old missing operands require fresh capture.",
      "Verify captured, redacted, missing, invalid and truncated states through ingest and the resulting bundle.",
      "",
      "```csharp",
      DOTNET_STRUCTURED_BODY_SOURCE,
      "```",
      "",
    ] : []),
    "## Keep the key out of git",
    "",
    `Once you replace ${placeholder} with a real key, this file holds a live`,
    "credential. Move it into your secret store or environment config and make",
    "sure this file (or wherever the key lands) is not committed to a public",
    "repository.",
    "",
  ].join("\n");
}

/**
 * Wrap a rendered guide as a `create` Plan so it goes through the normal
 * executor: refuses to overwrite an existing guide, rolls back on write failure.
 */
export function otlpGuidePlan(dir: string, body: string): Plan {
  return {
    recipe: "otlp",
    kind: "create",
    targetPath: path.join(dir, OTLP_GUIDE_FILENAME),
    content: body,
    warnings: [],
  };
}
