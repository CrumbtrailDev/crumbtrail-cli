import { defineConfig } from "tsup";

const packageConfig = {
  // `src/early.ts` is a second entry, not part of the main bundle: it must be
  // importable on its own line before anything else in the host app.
  //
  // `src/react` and `src/tauri` are framework adapters, published as the
  // `crumbtrail-core/react` and `crumbtrail-core/tauri` subpaths. They are
  // separate entries so that importing the core SDK never pulls React or the
  // Tauri IPC bridge into a bundle that has no use for them.
  // `src/serverless` stays separate so edge runtimes do not initialize the
  // browser collectors exported by the main entry.
  entry: [
    "src/index.ts",
    "src/early.ts",
    "src/react/index.ts",
    "src/tauri/index.ts",
    "src/serverless/index.ts",
  ],
  format: ["esm", "cjs"],
  // Optional peers: never bundled, so a consumer that imports only the core
  // entry never has to have them installed.
  external: ["react", "@tauri-apps/api", "@tauri-apps/api/core"],
  dts: true,
  clean: true,
};

const browserBootstrapConfig = {
  entry: ["src/early-bootstrap.ts"],
  format: ["iife"],
  globalName: "CrumbtrailEarlyBootstrap",
  platform: "browser",
  target: "es2019",
  splitting: false,
  dts: false,
  sourcemap: false,
  clean: false,
};

export default defineConfig([packageConfig, browserBootstrapConfig]);
