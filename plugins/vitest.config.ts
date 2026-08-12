import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const from = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// `plugins/` is not a workspace package, so this suite is run either directly
// (`pnpm test:plugins`) or as a project of the root config. `root` is pinned to
// the repository root so `include` means the same thing under both.
//
// The `crumbtrail-core` alias points at source rather than `dist`. The gate
// reads the tool table out of `packages/node/src`, which imports the core
// package by name; without the alias the suite would silently depend on a build
// and would read a stale tool list after a sibling change.
export default defineConfig({
  test: {
    name: "plugins",
    root: from(".."),
    environment: "node",
    include: ["plugins/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "crumbtrail-core/early": from("../packages/core/src/early.ts"),
      "crumbtrail-core": from("../packages/core/src/index.ts"),
    },
  },
});
