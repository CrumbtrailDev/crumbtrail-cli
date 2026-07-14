import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: [
    "crumbtrail-core",
    "react",
    "react-native",
    "@react-native-async-storage/async-storage",
    "@react-navigation/native",
    "react-native-view-shot",
  ],
});
