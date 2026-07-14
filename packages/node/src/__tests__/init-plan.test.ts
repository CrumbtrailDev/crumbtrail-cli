import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInitPlan, detectPackageManager } from "../init-plan";
import {
  PROVIDER_IDS,
  renderProviderCliOutput,
  renderProviderDoc,
} from "../provider-recipes";

const tempPaths: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-init-test-"));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("detectPackageManager", () => {
  it("detects pnpm from a pnpm lockfile", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("detects yarn from a yarn lockfile", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "yarn.lock"), "");
    expect(detectPackageManager(dir)).toBe("yarn");
  });

  it("detects npm from a package-lock", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("defaults to npm when no lockfile is present", () => {
    const dir = makeTempDir();
    expect(detectPackageManager(dir)).toBe("npm");
  });
});

describe("buildInitPlan", () => {
  const baseInput = (overrides: Record<string, unknown> = {}) => ({
    cwd: "/proj",
    pkg: {},
    packageManager: "pnpm" as const,
    env: {},
    ...overrides,
  });

  it("writes config with local self-host defaults and a project-local session dir", () => {
    const plan = buildInitPlan(baseInput());
    expect(plan.config).toEqual({
      host: "127.0.0.1",
      port: 9898,
      output: path.join("/proj", ".crumbtrail", "sessions"),
    });
    expect(plan.configPath).toBe(path.join("/proj", "crumbtrail.config.json"));
  });

  it("honours an explicit port across config and the client helper", () => {
    const plan = buildInitPlan(baseInput({ port: 4100 }));
    expect(plan.config.port).toBe(4100);
    const client = plan.files.find((f) => f.path.includes("crumbtrail.client"));
    expect(client?.contents).toContain("http://127.0.0.1:4100");
  });

  it("plans the two crumbtrail dependencies with a package-manager-specific install command", () => {
    expect(
      buildInitPlan(baseInput({ packageManager: "pnpm" })).installCommand,
    ).toBe("pnpm add crumbtrail-core crumbtrail-node");
    expect(
      buildInitPlan(baseInput({ packageManager: "npm" })).installCommand,
    ).toBe("npm install crumbtrail-core crumbtrail-node");
    expect(
      buildInitPlan(baseInput({ packageManager: "yarn" })).installCommand,
    ).toBe("yarn add crumbtrail-core crumbtrail-node");
    expect(buildInitPlan(baseInput()).dependencies).toEqual([
      "crumbtrail-core",
      "crumbtrail-node",
    ]);
  });

  it("always emits a browser client helper wired to Crumbtrail.init", () => {
    const plan = buildInitPlan(baseInput());
    const client = plan.files.find((f) => f.path.includes("crumbtrail.client"));
    expect(client).toBeDefined();
    expect(client?.contents).toContain("import('crumbtrail-core')");
    expect(client?.contents).toContain("crumbtrailReady");
    expect(client?.contents).toContain("Crumbtrail.init");
    expect(client?.contents).toContain("httpEndpoint");
  });

  describe("client helper wiring (Vite dev safety)", () => {
    it("uses a literal crumbtrail-core import specifier and no computed import()", () => {
      const plan = buildInitPlan({
        cwd: "/tmp/x",
        pkg: {},
        packageManager: "pnpm",
      });
      const client = plan.files.find((f) =>
        f.path.endsWith("crumbtrail.client.js"),
      )!;
      expect(client.contents).toContain("import('crumbtrail-core')");
      const computed = /import\(\s*(?!'crumbtrail-core'\s*\))/m;
      expect(computed.test(client.contents)).toBe(false);
      expect(client.contents).toContain("crumbtrailReady");
      expect(client.contents).toContain("httpEndpoint");
    });
  });

  it("emits an Express server helper only when express is a dependency", () => {
    const withExpress = buildInitPlan(
      baseInput({ pkg: { dependencies: { express: "^4.18.0" } } }),
    );
    expect(withExpress.hasExpress).toBe(true);
    const server = withExpress.files.find((f) =>
      f.path.includes("crumbtrail.server"),
    );
    expect(server?.contents).toContain("createCrumbtrailExpressMiddleware");
    expect(server?.contents).toContain(
      "createCrumbtrailExpressErrorMiddleware",
    );

    const withoutExpress = buildInitPlan(baseInput());
    expect(withoutExpress.hasExpress).toBe(false);
    expect(
      withoutExpress.files.find((f) => f.path.includes("crumbtrail.server")),
    ).toBeUndefined();
  });

  it("plans to gitignore the local session output and tells the user to run doctor", () => {
    const plan = buildInitPlan(baseInput());
    expect(plan.gitignoreEntry).toBe(".crumbtrail/");
    expect(plan.nextSteps.join("\n")).toMatch(/doctor/);
  });
});

describe("provider recipes", () => {
  it("covers the public provider init options", () => {
    expect(PROVIDER_IDS).toEqual([
      "otel",
      "datadog",
      "sentry",
      "grafana",
      "splunk",
    ]);
  });

  it("renders pasteable OTLP HTTP config for provider init", () => {
    const output = renderProviderCliOutput("datadog", "http://127.0.0.1:19898");
    expect(output).toContain("otlphttp/crumbtrail");
    expect(output).toContain("endpoint: http://127.0.0.1:19898");
    expect(output).toContain("crumbtrail-server doctor --port 9898");
  });

  it("renders docs from the same provider recipe", () => {
    const doc = renderProviderDoc("grafana");
    expect(doc).toContain("Grafana Alloy");
    expect(doc).toContain('otelcol.exporter.otlphttp "crumbtrail"');
    expect(doc).toContain("sessionless OTLP");
  });
});
