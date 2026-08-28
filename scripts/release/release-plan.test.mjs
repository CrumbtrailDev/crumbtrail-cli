import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertVersionedRuntimeConsumers,
  createReleasePlan,
  changedFilesSince,
  discoverPackages,
  preflightAndPublishArtifacts,
  resolveReleaseArtifactsDir,
  selectReleasePackages,
  topologicallyOrderReleasePackages,
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
    const privateFixture = pkg("crumbtrail-private-fixture", { privatePackage: true });
    expect(selectReleasePackages({ packages: [privateFixture], changedFiles: ["packages/private-fixture/src/index.ts"] })).toEqual([]);
  });

  it("does not treat noExternal examples in comments as bundled dependencies", () => {
    const core = pkg("crumbtrail-core");
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: '// noExternal: ["crumbtrail-core"]\nexport default { noExternal: ["crumbtrail-unrelated"] }',
    });
    expect(selectReleasePackages({ packages: [core, cli], changedFiles: ["packages/core/src/index.ts"] }).map((entry) => entry.name))
      .toEqual(["crumbtrail-core"]);
  });

  it("propagates a bundled dev dependency two hops into the CLI", () => {
    // Two hops is the case worth pinning: a bundled dependency of a bundled
    // dependency still changes the CLI tarball, so it must still select the CLI.
    // The packages here are synthetic — the real workspace no longer has a
    // two-hop bundling chain, and the policy still has to hold if one returns.
    const inner = pkg("crumbtrail-inner");
    const middle = pkg("crumbtrail-middle", {
      devDependencies: { "crumbtrail-inner": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-inner"] }',
    });
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-middle": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-middle"] }',
    });
    expect(selectReleasePackages({
      packages: [inner, middle, cli],
      changedFiles: ["packages/inner/src/index.ts"],
    }).map((entry) => entry.name)).toEqual([
      "crumbtrail",
      "crumbtrail-inner",
      "crumbtrail-middle",
    ]);
  });

  it("propagates a bundled core change directly to the CLI", () => {
    // The live one-hop case: the CLI declares core as a devDependency and tsup
    // bundles it, so core source lands inside the CLI tarball and a core change
    // has to select the CLI too. This is the invariant the fold nearly broke —
    // the CLI silently dropped out of the release set until noExternal said so.
    const core = pkg("crumbtrail-core");
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: 'export default { noExternal: ["crumbtrail-core"] }',
    });
    expect(selectReleasePackages({
      packages: [core, cli],
      changedFiles: ["packages/core/src/index.ts"],
    }).map((entry) => entry.name)).toEqual(["crumbtrail", "crumbtrail-core"]);
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
        "packages/cli/package.json",
        "packages/react-native/package.json",
        "packages/capacitor/package.json",
      ],
    });
    expect(plan.packages.map((entry) => entry.name)).toEqual([
      "crumbtrail",
      "crumbtrail-capacitor",
      "crumbtrail-core",
      "crumbtrail-node",
      "crumbtrail-react-native",
    ]);
  });

  // Base-ref plumbing must keep resolving in a fresh clone. This test used to
  // pin the literal SHA c7dacf4 as its baseline; the GitHub repository was
  // recreated and its history rebuilt, so that object now survives only in
  // local stores and CI could never resolve it again. Refs that a clone always
  // has are the only safe ones to name here.
  it("resolves a base ref that exists in any clone", async () => {
    await expect(changedFilesSince(repositoryRoot, "HEAD")).resolves.toEqual([]);
  });

  it("derives the full public release set from a single core change", async () => {
    // The invariant this test exists to protect is that the publish set cannot
    // silently GROW as workspace metadata changes. That is a property of the
    // package graph — runtime/peer/optional workspace deps and tsup noExternal
    // bundling — so the graph is read live from the real repository while the
    // release input and the expected names stay a deliberate, pinned fixture.
    //
    // Both inputs are explicit rather than derived from git history. The old
    // version of this test asked git for a diff against a frozen SHA, which
    // coupled a policy assertion to the shape of the commit graph: it went stale
    // on every release, and it broke outright when the repository history was
    // rebuilt. Passing the release input directly is what makes the expected set
    // reviewable — a change to these names is a change someone has to justify.
    //
    // The input is deliberately minimal: one changed manifest and one version
    // bump. Everything else in the expected set below arrives by propagation
    // through the live graph, so the assertion tests the selection policy rather
    // than restating a hand-written answer.
    const packages = await discoverPackages(repositoryRoot);
    const changedFiles = ["packages/core/package.json"];
    const versionChangedPackageNames = ["crumbtrail-core"];
    const selected = selectReleasePackages({ packages, changedFiles, versionChangedPackageNames });

    // This list is every public package the workspace still has, because after
    // the package consolidation each one does depend on core: the React and
    // Tauri adapters became crumbtrail-core subpaths, and detection and
    // install-shared became the crumbtrail package and its /install subpath, so
    // the four packages that used to sit outside the propagation graph no
    // longer exist to sit outside it. The tripwire is unchanged in spirit — if this list ever grows, a
    // workspace metadata edit is quietly republishing something new, and that
    // is a change someone has to justify.
    expect(selected.map((pkg) => pkg.name)).toEqual([
      "crumbtrail",
      "crumbtrail-capacitor",
      "crumbtrail-core",
      "crumbtrail-node",
      "crumbtrail-react-native",
    ]);

    // The release-blocking guard, run against the real graph rather than a
    // synthetic one: nothing may propagate into the publish set on a changed
    // runtime contract without receiving its own version bump. Bumping core
    // alone must be rejected, and it must name every consumer left behind.
    expect(() => assertVersionedRuntimeConsumers(selected, versionChangedPackageNames))
      .toThrow(/crumbtrail-capacitor.*crumbtrail-node.*crumbtrail-react-native/);
    // Bumping every propagated consumer clears it.
    expect(() => assertVersionedRuntimeConsumers(selected, selected.map((pkg) => pkg.name))).not.toThrow();

    // Every selected artifact publishes at exactly its manifest version.
    //
    // The versions this test used to pin went stale the moment any package was
    // bumped, because selection reads the live manifests while the expectation
    // was frozen. Not hypothetical: bdea8ce bumped the CLI to 0.7.3 and
    // detect-core to 0.2.1 against expectations of 0.7.2 and 0.2.0, and ci went
    // red and stayed red until this was rewritten. Reading the manifest back off
    // disk asserts the same property without re-arming that tripwire.
    for (const pkg of selected) {
      const manifest = JSON.parse(
        await readFile(
          path.join(repositoryRoot, pkg.relativeDir, "package.json"),
          "utf8",
        ),
      );
      expect(
        pkg.version,
        `${pkg.name} must publish at its manifest version`,
      ).toBe(manifest.version);
    }
  });

  it("rejects option-like and invalid base refs before Git receives them", () => {
    expect(() => validateBaseRef("--upload-pack=evil")).toThrow("Invalid base ref");
    expect(() => validateBaseRef("main...other")).toThrow("Invalid base ref");
  });
});

describe("release artifact safety", () => {
  const artifact = (name, integrity) => ({ name, version: "1.0.0", integrity, tarballPath: `/tmp/${name}.tgz` });

  it("confines recursive artifact cleanup to the dedicated repository descendant", () => {
    const rootDir = path.join(path.sep, "workspace", "crumbtrail-cli");
    expect(resolveReleaseArtifactsDir(rootDir, ".release-artifacts")).toBe(path.join(rootDir, ".release-artifacts"));
    expect(resolveReleaseArtifactsDir(rootDir, path.join(rootDir, ".release-artifacts")))
      .toBe(path.join(rootDir, ".release-artifacts"));
    expect(() => resolveReleaseArtifactsDir(rootDir, ".")).toThrow("dedicated .release-artifacts");
    expect(() => resolveReleaseArtifactsDir(rootDir, "..")).toThrow("dedicated .release-artifacts");
    expect(() => resolveReleaseArtifactsDir(rootDir, ".release-artifacts/../.release-artifacts"))
      .toThrow("dedicated .release-artifacts");
    expect(() => resolveReleaseArtifactsDir(rootDir, ".release-artifacts/nested")).toThrow("must use");
    expect(() => resolveReleaseArtifactsDir(rootDir, path.join(path.sep, "workspace", "crumbtrail-cli-evil", ".release-artifacts")))
      .toThrow("must use");
    expect(() => resolveReleaseArtifactsDir(rootDir, ".release-artifacts-evil")).toThrow("must use");
  });

  it("skips a prior publication only when its registry integrity exactly matches the packed tarball", async () => {
    const published = [];
    const result = await preflightAndPublishArtifacts([artifact("crumbtrail-core", "sha512-same")], {
      lookupIntegrity: async () => "sha512-same",
      publish: async (entry) => published.push(entry.name),
    });
    expect(published).toEqual([]);
    expect(result.skipped.map((entry) => entry.name)).toEqual(["crumbtrail-core"]);
    expect(result.published).toEqual([]);
  });

  it("aborts the whole batch before publishing when any existing tarball differs", async () => {
    const published = [];
    const lookedUp = [];
    await expect(preflightAndPublishArtifacts([
      artifact("crumbtrail-core", "sha512-local-core"),
      artifact("crumbtrail-node", "sha512-local-node"),
    ], {
      lookupIntegrity: async (name) => {
        lookedUp.push(name);
        return name === "crumbtrail-node" ? "sha512-other-node" : null;
      },
      publish: async (entry) => published.push(entry.name),
    })).rejects.toThrow("crumbtrail-node@1.0.0");
    expect(lookedUp).toEqual(["crumbtrail-core", "crumbtrail-node"]);
    expect(published).toEqual([]);
  });

  it("resumes after a mid-batch failure by skipping the exact artifact already published", async () => {
    const artifacts = [
      artifact("crumbtrail-core", "sha512-core"),
      artifact("crumbtrail-node", "sha512-node"),
      artifact("crumbtrail", "sha512-cli"),
    ];
    const registry = new Map();
    const firstAttemptPublished = [];
    await expect(preflightAndPublishArtifacts(artifacts, {
      lookupIntegrity: async (name) => registry.get(name) ?? null,
      publish: async (entry) => {
        firstAttemptPublished.push(entry.name);
        if (entry.name === "crumbtrail-node") throw new Error("transient npm failure");
        registry.set(entry.name, entry.integrity);
      },
    })).rejects.toThrow("transient npm failure");
    // crumbtrail does not depend on crumbtrail-node, so the node failure is no
    // reason to strand it on the previous version.
    expect(firstAttemptPublished).toEqual(["crumbtrail-core", "crumbtrail-node", "crumbtrail"]);
    expect(registry).toEqual(new Map([
      ["crumbtrail-core", "sha512-core"],
      ["crumbtrail", "sha512-cli"],
    ]));

    const rerunPublished = [];
    const rerun = await preflightAndPublishArtifacts(artifacts, {
      lookupIntegrity: async (name) => registry.get(name) ?? null,
      publish: async (entry) => {
        rerunPublished.push(entry.name);
        registry.set(entry.name, entry.integrity);
      },
    });
    expect(rerun.skipped.map((entry) => entry.name)).toEqual(["crumbtrail-core", "crumbtrail"]);
    expect(rerunPublished).toEqual(["crumbtrail-node"]);
    expect(registry).toEqual(new Map([
      ["crumbtrail-core", "sha512-core"],
      ["crumbtrail-node", "sha512-node"],
      ["crumbtrail", "sha512-cli"],
    ]));
  });

  it("publishes the rest of a lockstep set when one package fails, and reports every outcome", async () => {
    // The 0.32.0 release in the field: a brand-new package name has no trusted
    // publisher on npm yet, so its very first publish 404s while every other
    // package in the set is perfectly publishable.
    const attempted = [];
    const failure = preflightAndPublishArtifacts([
      artifact("crumbtrail-core", "sha512-core"),
      artifact("crumbtrail-capacitor", "sha512-capacitor"),
      artifact("crumbtrail-node", "sha512-node"),
      artifact("crumbtrail-react-native", "sha512-rn"),
    ], {
      lookupIntegrity: async () => null,
      dependenciesByName: new Map([
        ["crumbtrail-capacitor", ["crumbtrail-core"]],
        ["crumbtrail-node", ["crumbtrail-core"]],
        ["crumbtrail-react-native", ["crumbtrail-core"]],
      ]),
      publish: async (entry) => {
        attempted.push(entry.name);
        if (entry.name === "crumbtrail-capacitor") throw new Error("404 Not Found - PUT");
      },
    });
    await expect(failure).rejects.toThrow("Failed to publish: crumbtrail-capacitor@1.0.0 (404 Not Found - PUT)");
    await expect(failure).rejects.toThrow("Published: crumbtrail-core@1.0.0, crumbtrail-node@1.0.0, crumbtrail-react-native@1.0.0");
    expect(attempted).toEqual([
      "crumbtrail-core",
      "crumbtrail-capacitor",
      "crumbtrail-node",
      "crumbtrail-react-native",
    ]);
  });

  it("never publishes a package whose failed dependency is missing from the registry", async () => {
    const attempted = [];
    const failure = preflightAndPublishArtifacts([
      artifact("crumbtrail-core", "sha512-core"),
      artifact("crumbtrail-node", "sha512-node"),
      artifact("crumbtrail-react-native", "sha512-rn"),
    ], {
      lookupIntegrity: async () => null,
      dependenciesByName: new Map([
        ["crumbtrail-node", ["crumbtrail-core"]],
        ["crumbtrail-react-native", ["crumbtrail-node"]],
      ]),
      publish: async (entry) => {
        attempted.push(entry.name);
        if (entry.name === "crumbtrail-core") throw new Error("registry rejected the tarball");
      },
    });
    await expect(failure).rejects.toThrow("Not attempted, dependency unpublished: crumbtrail-node@1.0.0 (needs crumbtrail-core); crumbtrail-react-native@1.0.0 (needs crumbtrail-node)");
    await expect(failure).rejects.toThrow("Published: none.");
    expect(attempted).toEqual(["crumbtrail-core"]);
  });

  it("publishes selected artifacts in dependency-safe topological order", () => {
    // crumbtrail-middle is synthetic: the real workspace is one hop deep now,
    // and the ordering has to keep holding if a middle package ever returns.
    const packages = [
      { name: "crumbtrail", version: "1.0.0" },
      { name: "crumbtrail-core", version: "1.0.0" },
      { name: "crumbtrail-middle", version: "1.0.0" },
      { name: "crumbtrail-node", version: "1.0.0" },
    ];
    const ordered = topologicallyOrderReleasePackages(packages, new Map([
      ["crumbtrail", ["crumbtrail-middle"]],
      ["crumbtrail-middle", ["crumbtrail-core"]],
      ["crumbtrail-node", ["crumbtrail-core"]],
      ["crumbtrail-core", []],
    ]));
    expect(ordered.map((entry) => entry.name)).toEqual([
      "crumbtrail-core",
      "crumbtrail-middle",
      "crumbtrail",
      "crumbtrail-node",
    ]);
  });
});
