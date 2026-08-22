import { defineConfig } from "tsup";

/**
 * The CLI is CommonJS ONLY, and that is not an oversight.
 *
 * `bin` points at `dist/cli.cjs`. An ESM build of the same entry inlines
 * dependencies that reach for `require("fs")` at load time, which esbuild's ESM
 * output answers with `Dynamic require of "fs" is not supported` — so the file
 * existed, shipped, and died on its first line. Nothing referenced it, so
 * nothing caught it. The library entry stays dual because consumers import it
 * both ways; the executable has exactly one form.
 */
export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["cjs"],
    noExternal: ["crumbtrail-core"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // Intentional dual topology: core is INLINED here so the built server files never `require`
    // crumbtrail-core at runtime (node stays self-contained even if a consumer's core copy drifts).
    // package.json ALSO declares crumbtrail-core as a real dependency (workspace:^ -> the current Core caret range on pack)
    // so `npm i crumbtrail-node` pulls core into node_modules for the browser SDK half of the
    // quickstart. Net: node's runtime uses the inlined copy; the installed copy is for the consumer's
    // own browser code. Don't "clean up" the dependency to match the bundling — verify-fresh-install
    // enforces both halves on purpose.
    noExternal: ["crumbtrail-core"],
    dts: true,
    clean: false,
  },
]);
