import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "dev-harness",
    include: ["scripts/dev-harness/**/*.test.mjs"],
  },
});
