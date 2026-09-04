import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DOTNET_PACKAGE, DOTNET_VERSION } from "./dotnet-package";

export function runDotnetCommand(args: string[]): number {
  const usage =
    "Usage: crumbtrail dotnet install <project.csproj> [--source <NuGet source>]";
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return 0;
  }
  if (
    args[0] !== "install" ||
    !args[1] ||
    (args.length !== 2 &&
      !(args.length === 4 && args[2] === "--source" && args[3]))
  ) {
    console.error(usage);
    return 1;
  }
  const project = path.resolve(args[1]);
  if (
    path.extname(project) !== ".csproj" ||
    !fs.existsSync(project) ||
    !fs.statSync(project).isFile()
  ) {
    console.error("Provide an existing .csproj file.");
    return 1;
  }
  const command = [
    "add",
    project,
    "package",
    DOTNET_PACKAGE,
    "--version",
    DOTNET_VERSION,
  ];
  if (args[3]) command.push("--source", args[3]);
  const result = spawnSync(process.env.CRUMBTRAIL_DOTNET || "dotnet", command, {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    console.error("Could not run dotnet. Install the .NET 9 SDK, then retry.");
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  console.log(
    "Package reference updated. Register AddCrumbtrail and UseCrumbtrail and select eligible routes before capture can start.",
  );
  return 0;
}
