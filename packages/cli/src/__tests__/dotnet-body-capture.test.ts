import { buildAgentPrompt } from "../install/index";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { renderOtlpGuide } from "../otlp-guide";
import { DOTNET_PACKAGE, DOTNET_VERSION } from "../dotnet-package";

it("routes .NET JSON capture to the owned package without copying source", () => {
  const input = {
    serviceName: "api",
    endpoint: "https://capture.example",
    snippet: "export OTEL_SERVICE_NAME=api",
    agentPrompt: "Configure tracing",
  };
  const guide = renderOtlpGuide({ ...input, stack: "dotnet" });
  expect(guide).toContain("crumbtrail dotnet install");
  expect(guide).toContain(DOTNET_PACKAGE);
  expect(guide).toContain(DOTNET_VERSION);
  expect(guide).toContain("AddCrumbtrail");
  expect(guide).toContain("UseCrumbtrail");
  expect(guide).not.toContain("class StructuredBody");
  expect(guide).not.toContain("There is no SDK to install");
  expect(renderOtlpGuide({ ...input, stack: "rails" })).not.toContain(
    DOTNET_PACKAGE,
  );
  const project = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../dotnet/Crumbtrail.AspNetCore/Crumbtrail.AspNetCore.csproj",
    ),
    "utf8",
  );
  expect(project).toContain(`<Version>${DOTNET_VERSION}</Version>`);
  expect(project).toContain(`<PackageId>${DOTNET_PACKAGE}</PackageId>`);
});

it("uses the owned package in the shared hosted and single service setup prompt", () => {
  const prompt = buildAgentPrompt(
    "dotnet",
    { endpoint: "https://capture.example", apiKey: "never-inline" },
    { serviceName: "orders" },
  );
  expect(prompt).toContain("Crumbtrail.AspNetCore 0.1.0");
  expect(prompt).toContain("crumbtrail dotnet install");
  expect(prompt).toContain("ShouldCapture");
  expect(prompt).not.toContain("never-inline");
  expect(prompt).not.toContain("Do NOT install a");
});
