import { describe, expect, it } from "vitest";
import { detect } from "../../detect";
import { memoryReader } from "../../testing";
import {
  parsePackageManagerField,
  resolveWorkspacePackageManager,
} from "../workspace-package-manager";

/** A pnpm monorepo with two workspace members and no lockfiles of their own. */
const PNPM_MONOREPO = {
  "/repo/pnpm-lock.yaml": "",
  "/repo/pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
  "/repo/package.json": JSON.stringify({ name: "root", private: true }),
  "/repo/services/changebase/package.json": JSON.stringify({
    name: "changebase",
  }),
  "/repo/services/mobile-gateway/package.json": JSON.stringify({
    name: "mobile-gateway",
  }),
};

describe("the package manager is a property of the workspace", () => {
  it("gives every workspace member the root's manager", () => {
    const reader = memoryReader(PNPM_MONOREPO, "/repo");
    for (const dir of [
      "/repo",
      "/repo/services/changebase",
      "/repo/services/mobile-gateway",
    ]) {
      expect(resolveWorkspacePackageManager(dir, reader).manager).toBe("pnpm");
    }
  });

  // The reported defect: one wizard run added the SDK with `pnpm add` in five
  // services and `npm install` in two others of the SAME pnpm monorepo, because
  // those two carried a stale package-lock.json and the nearest-lockfile walk
  // stopped there. npm then rewrote that lock inside the pnpm workspace.
  it("ignores a stale lockfile inside a workspace member, and says which", () => {
    const reader = memoryReader(
      {
        ...PNPM_MONOREPO,
        "/repo/services/changebase/package-lock.json": "{}",
      },
      "/repo",
    );
    const res = resolveWorkspacePackageManager(
      "/repo/services/changebase",
      reader,
    );
    expect(res.manager).toBe("pnpm");
    expect(res.workspaceRoot).toBe("/repo");
    expect(res.ignoredNestedLockfiles).toEqual([
      "/repo/services/changebase/package-lock.json",
    ]);
  });

  it("does not report a nested lockfile when there is nothing to ignore", () => {
    const reader = memoryReader(PNPM_MONOREPO, "/repo");
    expect(
      resolveWorkspacePackageManager("/repo/services/changebase", reader)
        .ignoredNestedLockfiles,
    ).toEqual([]);
  });

  it("treats pnpm-workspace.yaml alone as pnpm, before any install has run", () => {
    const reader = memoryReader(
      {
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
        "/repo/package.json": "{}",
        "/repo/services/api/package.json": "{}",
      },
      "/repo",
    );
    const res = resolveWorkspacePackageManager("/repo/services/api", reader);
    expect(res.manager).toBe("pnpm");
    expect(res.source).toBe("workspace-file");
  });

  it("prefers the root's packageManager field over any lockfile", () => {
    const reader = memoryReader(
      {
        "/repo/package.json": JSON.stringify({
          workspaces: ["services/*"],
          packageManager: "yarn@4.2.2",
        }),
        "/repo/package-lock.json": "{}",
        "/repo/services/api/package.json": "{}",
      },
      "/repo",
    );
    const res = resolveWorkspacePackageManager("/repo/services/api", reader);
    expect(res.manager).toBe("yarn");
    expect(res.source).toBe("package-manager-field");
  });

  it("still resolves a standalone app from its own lockfile", () => {
    const reader = memoryReader(
      { "/app/package.json": "{}", "/app/bun.lockb": "" },
      "/app",
    );
    const res = resolveWorkspacePackageManager("/app", reader);
    expect(res.manager).toBe("bun");
    expect(res.workspaceRoot).toBeNull();
  });

  // The mirror mistake: taking a manager away from a project that is not a
  // member. A fixture or vendored example sitting inside someone else's
  // monorepo keeps its own lockfile.
  it("leaves a non-member project inside a monorepo on its own lockfile", () => {
    const reader = memoryReader(
      {
        ...PNPM_MONOREPO,
        "/repo/test-fixtures/example/package.json": "{}",
        "/repo/test-fixtures/example/package-lock.json": "{}",
      },
      "/repo",
    );
    const res = resolveWorkspacePackageManager(
      "/repo/test-fixtures/example",
      reader,
    );
    expect(res.manager).toBe("npm");
    expect(res.workspaceRoot).toBeNull();
    expect(res.ignoredNestedLockfiles).toEqual([]);
  });

  it("honours a pnpm-workspace exclusion pattern", () => {
    const reader = memoryReader(
      {
        "/repo/pnpm-lock.yaml": "",
        "/repo/pnpm-workspace.yaml":
          "packages:\n  - 'services/*'\n  - '!services/legacy'\n",
        "/repo/package.json": "{}",
        "/repo/services/legacy/package.json": "{}",
        "/repo/services/legacy/yarn.lock": "",
      },
      "/repo",
    );
    expect(
      resolveWorkspacePackageManager("/repo/services/legacy", reader).manager,
    ).toBe("yarn");
  });

  it("matches a deep `**` member pattern", () => {
    const reader = memoryReader(
      {
        "/repo/pnpm-lock.yaml": "",
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/**'\n",
        "/repo/package.json": "{}",
        "/repo/apps/group/web/package.json": "{}",
        "/repo/apps/group/web/package-lock.json": "{}",
      },
      "/repo",
    );
    expect(
      resolveWorkspacePackageManager("/repo/apps/group/web", reader).manager,
    ).toBe("pnpm");
  });

  it("finds nothing when the repo carries no evidence at all", () => {
    const reader = memoryReader({ "/app/package.json": "{}" }, "/app");
    const res = resolveWorkspacePackageManager("/app", reader);
    expect(res.manager).toBeNull();
    expect(res.source).toBe("none");
  });

  it("never escapes the reader's root", () => {
    const reader = memoryReader(
      { "/repo/apps/web/package.json": "{}", "/yarn.lock": "" },
      "/repo",
    );
    expect(
      resolveWorkspacePackageManager("/repo/apps/web", reader).manager,
    ).toBeNull();
  });

  it("carries the decision out of detect() for every workspace member", () => {
    const reader = memoryReader(
      {
        ...PNPM_MONOREPO,
        "/repo/services/changebase/package-lock.json": "{}",
        "/repo/services/changebase/index.js": "",
      },
      "/repo",
    );
    const changebase = detect("/repo/services/changebase", reader);
    const gateway = detect("/repo/services/mobile-gateway", reader);
    expect(changebase.packageManager).toBe("pnpm");
    expect(gateway.packageManager).toBe("pnpm");
    expect(changebase.packageManagerInfo?.ignoredNestedLockfiles).toEqual([
      "/repo/services/changebase/package-lock.json",
    ]);
  });
});

describe("parsePackageManagerField", () => {
  it("reads the corepack spec, and only managers we run", () => {
    expect(parsePackageManagerField("pnpm@9.1.0")).toBe("pnpm");
    expect(parsePackageManagerField("npm@10.8.1+sha512.abc")).toBe("npm");
    expect(parsePackageManagerField("cargo@1.0.0")).toBeNull();
    expect(parsePackageManagerField(undefined)).toBeNull();
  });
});
