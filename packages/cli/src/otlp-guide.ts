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
import { DOTNET_PACKAGE, DOTNET_VERSION } from "./dotnet-package";
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
    `${input.stack} can send OpenTelemetry traces directly to Crumbtrail.`,
    input.stack === "dotnet"
      ? "For JSON request evidence, install the ASP.NET Core package described below."
      : "Configure the exporter below to send traces.",
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
    ...(input.stack === "dotnet"
      ? [
          "## Capture JSON request and response evidence",
          "",
          "Install the Crumbtrail maintained ASP.NET Core package. Requires .NET 9.",
          "Version " +
            DOTNET_VERSION +
            " must be available in your NuGet source before installation.",
          "```sh",
          "crumbtrail dotnet install path/to/Your.Api.csproj",
          "```",
          "The same command updates an existing package reference to the CLI supported version.",
          `It installs ${DOTNET_PACKAGE} ${DOTNET_VERSION}. It does not edit application startup.`,
          "Register the package in Program.cs:",
          "```csharp",
          "using Crumbtrail;",
          `builder.Services.AddCrumbtrail(CaptureOptions.FromEnvironment(${JSON.stringify(input.serviceName)}) with`,
          "{",
          '    ShouldCapture = context => context.Request.Path.StartsWithSegments("/api/orders")',
          "});",
          "// After app.UseRouting(), before mapping endpoints:",
          "app.UseCrumbtrail();",
          "```",
          "Replace the example route with eligible application routes. Exclude authentication routes.",
          "Set CRUMBTRAIL_ENDPOINT to the capture HTTPS origin and CRUMBTRAIL_INGEST_KEY to the project key.",
          "No routes are captured by default. Missing correlation headers means no capture.",
          "The package handles bounded buffering, redaction, response capture and queued delivery.",
          "Verify backend.req.start and backend.req.end in a browser session, including safe JSON values.",
          "Oversized bodies are omitted. Unsupported values are withheld by a conservative profile.",
          "Update the package to update capture behavior. Do not copy middleware or redaction source.",
          "",
        ]
      : []),
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
