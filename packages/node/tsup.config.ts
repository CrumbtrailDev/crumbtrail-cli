import { defineConfig } from "tsup";

/**
 * One entry: the capture library. The `crumbtrail-server` binary and the
 * analysis it drove now live in the cloud, so there is no executable to build
 * and no CJS-only special case to preserve.
 *
 * Core is INLINED so the built files never `require` crumbtrail-core at
 * runtime, while package.json still declares it as a real dependency so
 * `npm i crumbtrail-node` pulls core in for the browser half of the
 * quickstart. verify-fresh-install enforces both halves on purpose.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  noExternal: ["crumbtrail-core"],
  dts: true,
  clean: true,
});
