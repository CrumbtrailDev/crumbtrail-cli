import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the setup file against this config's own directory rather than the
// process CWD. Vitest anchors relative setupFiles to its `root` (the CWD), so a
// bare "./src/..." only resolves when invoked from packages/core. Broad-suite /
// direct runs from the monorepo root (e.g. `vitest run --config
// packages/core/vitest.config.ts packages/core/src`) otherwise fail to load the
// setup file, and every suite collects zero events.
const setupFile = fileURLToPath(
  new URL("./src/__tests__/setup.ts", import.meta.url),
);

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: [setupFile],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      all: true,
      include: ["src/**/*.{ts,tsx}", "app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/__tests__/**",
        "**/__mocks__/**",
        "**/*.d.ts",
        "**/coverage/**",
      ],
    },
  },
});
