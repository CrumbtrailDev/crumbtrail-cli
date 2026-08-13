import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: [
    "crumbtrail-core",
    "@capacitor/core",
    "@capacitor/app",
    "@capacitor/device",
    "@capacitor/network",
    "@capacitor/preferences",
    "@capacitor/screen-orientation",
  ],
});
