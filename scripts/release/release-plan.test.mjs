import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertVersionedRuntimeConsumers,
  createReleasePlan,
  changedFilesSince,
  discoverPackages,
  packageExistsOnNpm,
  preflightAndPublish,
  preflightNpmVersions,
  selectReleasePackages,
  validateBaseRef,
} from "./release-plan.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pkg(name, { privatePackage = false, dependencies, optionalDependencies, peerDependencies, devDependencies, tsupConfig = "" } = {}) {
  return {
    name,
    version: "1.0.0",
    private: privatePackage,
    relativeDir: `packages/${name.replace("crumbtrail-", "")}`,
    manifest: { dependencies, optionalDependencies, peerDependencies, devDependencies },
    tsupConfig,
  };
}

describe("release package selection", () => {
  it("selects changed public packages and bundled public dependents", () => {
    const core = pkg("crumbtrail-core");
    const node = pkg("crumbtrail-node", {
      dependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: '// noExternal: ["not-a-real-dependency"]\nexport default { noExternal: ["crumbtrail-core"] }',
    });
    const reactNative = pkg("crumbtrail-react-native", {
      dependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: 'export default { external: ["crumbtrail-core"] }',
    });
    expect(selectReleasePackages({ packages: [core, node, reactNative], changedFiles: ["packages/core/src/index.ts"] }).map((entry) => entry.name))
      .toEqual(["crumbtrail-core", "crumbtrail-node"]);
  });

  it("never selects private packages even when their files change", () => {
    const privateHarness = pkg("crumbtrail-topology-harness", { privatePackage: true });
    expect(selectReleasePackages({ packages: [privateHarness], changedFiles: ["packages/topology-harness/src/index.ts"] })).toEqual([]);
  });

  it("does not treat noExternal examples in comments as bundled dependencies", () => {
    const core = pkg("crumbtrail-core");
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: '// noExternal: ["crumbtrail-core"]\nexport default { noExternal: ["crumbtrail-install-shared"] }',
    });
    expect(selectReleasePackages({ packages: [core, cli], changedFiles: ["packages/core/src/index.ts"] }).map((entry) => entry.name))
      .toEqual(["crumbtrail-core"]);
  });

  it("propagates bundled dev dependencies through install-shared, detect-core, and CLI", () => {
    const installShared = pkg("crumbtrail-install-shared");
    const detectCore = pkg("crumbtrail-detect-core", {
      devDependencies: { "crumbtrail-install-shared": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-install-shared"] }',
    });
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-detect-core": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-detect-core"] }',
    });
    expect(selectReleasePackages({
      packages: [installShared, detectCore, cli],
      changedFiles: ["packages/install-shared/src/index.ts"],
    }).map((entry) => entry.name)).toEqual([
      "crumbtrail",
      "crumbtrail-detect-core",
      "crumbtrail-install-shared",
    ]);
  });

  it("propagates a bundled detect-core change directly to CLI", () => {
    const detectCore = pkg("crumbtrail-detect-core");
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-detect-core": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-detect-core"] }',
    });
    expect(selectReleasePackages({
      packages: [detectCore, cli],
      changedFiles: ["packages/detect-core/src/index.ts"],
    }).map((entry) => entry.name)).toEqual(["crumbtrail", "crumbtrail-detect-core"]);
  });

  it("propagates a changed workspace runtime dependency to its public consumer", () => {
    const core = pkg("crumbtrail-core");
    const reactNative = pkg("crumbtrail-react-native", { dependencies: { "crumbtrail-core": "workspace:^" } });
    expect(selectReleasePackages({
      packages: [core, reactNative],
      changedFiles: ["packages/core/package.json"],
      versionChangedPackageNames: ["crumbtrail-core"],
    }).map((entry) => entry.name)).toEqual(["crumbtrail-core", "crumbtrail-react-native"]);
  });

  it("propagates optional and peer workspace contracts, but not dev-only contracts", () => {
    const core = pkg("crumbtrail-core");
    const optionalConsumer = pkg("crumbtrail-optional", { optionalDependencies: { "crumbtrail-core": "workspace:^" } });
    const peerConsumer = pkg("crumbtrail-peer", { peerDependencies: { "crumbtrail-core": "workspace:^" } });
    const devConsumer = pkg("crumbtrail-dev", { devDependencies: { "crumbtrail-core": "workspace:^" } });
    expect(selectReleasePackages({
      packages: [core, optionalConsumer, peerConsumer, devConsumer],
      changedFiles: ["packages/core/package.json"],
      versionChangedPackageNames: ["crumbtrail-core"],
    }).map((entry) => entry.name)).toEqual([
      "crumbtrail-core",
      "crumbtrail-optional",
      "crumbtrail-peer",
    ]);
  });

  it("fails explicitly when a propagated consumer was not version-bumped", () => {
    const core = pkg("crumbtrail-core");
    const reactNative = pkg("crumbtrail-react-native", { dependencies: { "crumbtrail-core": "workspace:^" } });
    expect(() => assertVersionedRuntimeConsumers([core, reactNative], ["crumbtrail-core"])).toThrow(
      "crumbtrail-react-native",
    );
  });

  it("does not select every public package for root-only workspace metadata changes", async () => {
    const packages = await discoverPackages(repositoryRoot);
    expect(selectReleasePackages({
      packages,
      changedFiles: ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
    })).toEqual([]);
  });

  it("derives the runtime and peer release set alongside root release metadata", async () => {
    const plan = await createReleasePlan({
      rootDir: repositoryRoot,
      baseRef: "HEAD",
      changedFiles: [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "packages/core/package.json",
        "packages/node/package.json",
        "packages/detect-core/package.json",
        "packages/cli/package.json",
        "packages/install-shared/package.json",
        "packages/react-native/package.json",
        "packages/tauri/package.json",
      ],
    });
    expect(plan.packages.map((entry) => entry.name)).toEqual([
      "crumbtrail",
      "crumbtrail-core",
      "crumbtrail-detect-core",
      "crumbtrail-install-shared",
      "crumbtrail-node",
      "crumbtrail-react-native",
      "crumbtrail-tauri",
    ]);
  });

  it("derives the complete Phase 0 release set and exercises collision preflight", async () => {
    // c7dacf4 is the last commit immediately before PR #17. Keep this test
    // tied to the real release range so the workflow cannot silently grow the
    // Phase 0 publish set as workspace metadata changes.
    // Add this checkpoint's uncommitted package paths so the test has the same
    // release range it will see once this commit becomes HEAD in CI.
    const changedFiles = new Set(await changedFilesSince(repositoryRoot, "c7dacf4"));
    for (const file of [
      "packages/core/package.json",
      "packages/node/package.json",
      "packages/detect-core/package.json",
      "packages/cli/package.json",
      "packages/install-shared/package.json",
      "packages/react-native/package.json",
      "packages/tauri/package.json",
    ]) changedFiles.add(file);
    const plan = await createReleasePlan({
      rootDir: repositoryRoot,
      baseRef: "c7dacf4",
      changedFiles: [...changedFiles],
    });
    expect(plan.packages).toEqual([
      { name: "crumbtrail", version: "0.7.2", relativeDir: "packages/cli" },
      { name: "crumbtrail-core", version: "0.6.0", relativeDir: "packages/core" },
      { name: "crumbtrail-detect-core", version: "0.2.0", relativeDir: "packages/detect-core" },
      { name: "crumbtrail-install-shared", version: "0.4.0", relativeDir: "packages/install-shared" },
      { name: "crumbtrail-node", version: "0.9.0", relativeDir: "packages/node" },
      { name: "crumbtrail-react-native", version: "0.3.0", relativeDir: "packages/react-native" },
      { name: "crumbtrail-tauri", version: "0.3.0", relativeDir: "packages/tauri" },
    ]);
    await expect(preflightNpmVersions(plan.packages, {
      exec: async () => {
        const error = new Error("not found");
        error.code = 1;
        error.stderr = "npm error code E404\\nnpm error 404 Not Found";
        throw error;
      },
    })).resolves.toBeUndefined();
  });

  it("rejects option-like and invalid base refs before Git receives them", () => {
    expect(() => validateBaseRef("--upload-pack=evil")).toThrow("Invalid base ref");
    expect(() => validateBaseRef("main...other")).toThrow("Invalid base ref");
  });
});

describe("npm collision preflight", () => {
  it("accepts a mocked npm not-found response as an available version", async () => {
    const exists = await packageExistsOnNpm("crumbtrail-core", "99.0.0", {
      exec: async () => {
        const error = new Error("not found");
        error.code = 1;
        error.stderr = "npm error code E404\nnpm error 404 Not Found";
        throw error;
      },
    });
    expect(exists).toBe(false);
  });

  it("recognizes an existing selected version as a collision", async () => {
    const exists = await packageExistsOnNpm("crumbtrail-core", "1.0.0", { exec: async () => ({ stdout: '"1.0.0"' }) });
    expect(exists).toBe(true);
  });

  it("fails the release before publish when any selected version exists", async () => {
    await expect(preflightNpmVersions([{ name: "crumbtrail-core", version: "1.0.0" }], {
      exec: async () => ({ stdout: '"1.0.0"' }),
    })).rejects.toThrow("crumbtrail-core@1.0.0");
  });

  it("runs collision preflight before the first publish", async () => {
    const calls = [];
    await expect(preflightAndPublish([{ name: "crumbtrail-core", version: "1.0.0" }], {
      preflight: async () => {
        calls.push("preflight");
        throw new Error("collision");
      },
      publish: async () => calls.push("publish"),
    })).rejects.toThrow("collision");
    expect(calls).toEqual(["preflight"]);
  });
});
