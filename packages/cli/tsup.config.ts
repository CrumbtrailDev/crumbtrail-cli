import { defineConfig } from "tsup";

export default defineConfig({
  // `src/install` is the shared install recipe / OTLP fact / agent prompt
  // surface, published as the `crumbtrail/install` subpath. It is a separate
  // entry because the dashboard imports it into a browser bundle: it must not
  // drag in the node-only detection and filesystem code the CLI entry uses.
  //
  // `src/testing` is the in-memory reader, kept off the root barrel so it is
  // opt-in rather than something a consumer stumbles into.
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/install/index.ts",
    "src/testing.ts",
  ],
  format: ["esm", "cjs"],
  // crumbtrail-core is bundled, not required at runtime: the CLI declares no
  // dependencies, and the only thing it needs from core is a handful of
  // constants that tree-shake down to inline values. Declaring it here rather
  // than leaning on tsup's bundle-devDependencies default is what lets the
  // release planner see that a core change alters this tarball — without it the
  // CLI silently drops out of the release set on a core-only change.
  noExternal: ["crumbtrail-core"],
  dts: true,
  clean: true,
});
