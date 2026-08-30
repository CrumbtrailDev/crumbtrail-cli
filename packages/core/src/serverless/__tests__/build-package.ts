import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const lockPath = path.join(
  os.tmpdir(),
  "crumbtrail-core-serverless-boundary-build.lock",
);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function buildCorePackage(packageRoot: string): void {
  const deadline = Date.now() + 60_000;
  let waitedForBuild = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      waitedForBuild = true;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the core package build lock", {
          cause: error,
        });
      }
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }

  try {
    const serverlessDist = path.join(packageRoot, "dist/serverless");
    if (
      waitedForBuild &&
      fs.existsSync(path.join(serverlessDist, "index.js")) &&
      fs.existsSync(path.join(serverlessDist, "index.cjs")) &&
      fs.existsSync(path.join(serverlessDist, "index.d.ts"))
    ) {
      return;
    }

    execFileSync("pnpm", ["run", "build"], {
      cwd: packageRoot,
      stdio: "pipe",
    });
  } finally {
    fs.rmdirSync(lockPath);
  }
}
