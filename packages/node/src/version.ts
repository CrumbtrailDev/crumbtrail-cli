import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the crumbtrail-node package version by walking up from this module to the nearest
 * package.json named `crumbtrail-node`. The same layout holds in dev/test (src/version.ts →
 * ../package.json) and in the published build (dist/cli.cjs → ../package.json), so no
 * build-time baking is required.
 */
export function readPackageVersion(): string {
  let current = moduleDir();
  for (let depth = 0; depth < 6; depth++) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(current, "package.json"), "utf-8"),
      ) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === "crumbtrail-node" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // No readable package.json here — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "0.0.0";
}

function moduleDir(): string {
  // The published bin is a CJS bundle (dist/cli.cjs) where `__dirname` is defined; dev/test run
  // as ESM where it is not, so fall back to import.meta.url there. The unused branch is never
  // executed in either format, sidestepping esbuild's lack of an import.meta shim for CJS.
  if (typeof __dirname !== "undefined") return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}
