import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { runDotnetCommand } from "../dotnet-command";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockReset();
});
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotnet-install-"));
  dirs.push(dir);
  const file = path.join(dir, "Example Api.csproj");
  fs.writeFileSync(file, '<Project Sdk="Microsoft.NET.Sdk.Web" />');
  return file;
}
it("installs the pinned package without shell interpolation", () => {
  const file = project();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);
  expect(
    runDotnetCommand(["install", file, "--source", "/tmp/feed with spaces"]),
  ).toBe(0);
  expect(spawnSync).toHaveBeenCalledWith(
    expect.any(String),
    [
      "add",
      file,
      "package",
      "Crumbtrail.AspNetCore",
      "--version",
      "0.1.0",
      "--source",
      "/tmp/feed with spaces",
    ],
    { stdio: "inherit", shell: false },
  );
});
it("refuses invalid arguments without starting dotnet", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const args of [
    ["install"],
    ["install", "/missing.csproj"],
    ["install", project(), "--unknown"],
    ["install", project(), "--source"],
  ])
    expect(runDotnetCommand(args)).toBe(1);
  expect(spawnSync).not.toHaveBeenCalled();
});
it("reports restore failure without claiming successful installation", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(spawnSync).mockReturnValue({ status: 7 } as never);
  expect(runDotnetCommand(["install", project()])).toBe(7);
  expect(output).not.toHaveBeenCalled();
});
