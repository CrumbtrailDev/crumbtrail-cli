import { defineConfig } from "tsup";

export default defineConfig({
  // `src/install` is the shared install recipe / OTLP fact / agent prompt
  // surface, published as the `crumbtrail-detect-core/install` subpath. It was
  // its own package (crumbtrail-install-shared) and was inlined here via
  // noExternal anyway; it is now plain source in this package, so the bundler
  // has nothing special to do.
  entry: ["src/index.ts", "src/testing.ts", "src/install/index.ts"],
  format: ["esm", "cjs"],
  // crumbtrail-core is deliberately NOT bundled. Our own source uses it only as
  // `import type { Stack }`, and the one real runtime value we need (STACK_IDS,
  // reached through src/install) is a single array. Bundling it pulled the
  // entire browser SDK in, including an orphaned shadow DOM bug-widget chunk
  // that nothing referenced and that we then published. It is a declared
  // dependency instead, so both the runtime import and the emitted declarations
  // resolve for consumers.
  dts: true,
  clean: true,
});
