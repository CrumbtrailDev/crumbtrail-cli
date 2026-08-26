import { describe, expect, it } from "vitest";
import path from "node:path";
import { inspectIntegration } from "../inject/integration";
import { buildPlan } from "../inject/recipes";
import { fakeInjectIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const p = (...parts: string[]) => path.join(CWD, ...parts);

function completeBrowserFiles(): Record<string, string> {
  return {
    [p("package.json")]: JSON.stringify({
      dependencies: { "crumbtrail-core": "0.37.0" },
    }),
    [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
    [p("src", "main.tsx")]: [
      'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
      "Crumbtrail.init({",
      "  ...PRESET_PASSIVE,",
      `  httpEndpoint: "${ENDPOINT}",`,
      "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
      "  remoteConfig: true,",
      '  service: "web",',
      "});",
    ].join("\n"),
    [p(".env.local")]: "VITE_CRUMBTRAIL_KEY=ctkey_test\n",
  };
}

describe("inspectIntegration", () => {
  it("requires complete endpoint, key, service and remote configuration evidence", () => {
    const status = inspectIntegration({
      cwd: CWD,
      recipe: "vite-spa",
      endpoint: ENDPOINT,
      entryFile: p("src", "main.tsx"),
      serviceName: "web",
      io: fakeInjectIO(completeBrowserFiles()),
    });

    expect(status).toEqual({ complete: true, found: true, missing: [] });
  });

  it("does not call a local only helper complete", () => {
    const files = {
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-core": "0.37.0" },
      }),
      [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
      [p("src", "main.jsx")]:
        "import { initCrumbtrail } from './lib/crumbtrail.js';\ninitCrumbtrail();\n",
      [p("src", "lib", "crumbtrail.js")]: [
        "const ENDPOINT = import.meta.env.VITE_CRUMBTRAIL_ENDPOINT || 'http://localhost:9898';",
        "const API_KEY = import.meta.env.VITE_CRUMBTRAIL_API_KEY || undefined;",
        "export async function initCrumbtrail() {",
        "  const { Crumbtrail } = await import('crumbtrail-core');",
        "  return Crumbtrail.init({ httpEndpoint: ENDPOINT, httpAuthToken: API_KEY });",
        "}",
      ].join("\n"),
      [p(".env")]: "VITE_CRUMBTRAIL_KEY=ctkey_test\n",
    };
    const status = inspectIntegration({
      cwd: CWD,
      recipe: "vite-spa",
      endpoint: ENDPOINT,
      entryFile: p("src", "main.jsx"),
      serviceName: "client",
      io: fakeInjectIO(files),
    });

    expect(status.complete).toBe(false);
    expect(status.found).toBe(true);
    // No "remote-config": that helper never says `remoteConfig: false`, and the
    // default is on, so the project's settings already reach it.
    expect(status.missing).toEqual(["endpoint", "ingest-key", "service-name"]);
  });

  it("routes an incomplete reachable integration to guidance instead of a second init", () => {
    const files = {
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-core": "0.37.0" },
      }),
      [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
      [p("src", "main.jsx")]:
        "import { initCrumbtrail } from './lib/crumbtrail.js';\ninitCrumbtrail();\n",
      [p("src", "lib", "crumbtrail.js")]:
        "export function initCrumbtrail() { return import('crumbtrail-core'); }\n",
    };
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.jsx"),
        serviceName: "client",
        options: { force: true },
      },
      fakeInjectIO(files),
    );

    expect(plan.kind).toBe("fallback-ai");
    expect(plan.content).toBeNull();
    expect(plan.warnings.join(" ")).toContain(
      "will not add a second initialization",
    );
    expect(plan.warnings.join(" ")).toContain("the install endpoint");
    // Guidance that does not end in something to do is where the install used
    // to stop. Every unresolved requirement names its own next step.
    expect(plan.warnings.join(" ")).toContain("Next:");
  });
});

describe("amending an integration the customer already has", () => {
  const amendableFiles = (): Record<string, string> => ({
    [p("package.json")]: JSON.stringify({
      dependencies: { "crumbtrail-core": "0.37.0" },
    }),
    [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
    [p("src", "main.tsx")]: [
      'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
      "",
      "Crumbtrail.init({",
      "  ...PRESET_PASSIVE,",
      `  httpEndpoint: "${ENDPOINT}",`,
      "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
      "});",
      "",
      "console.log('app boot');",
    ].join("\n"),
    [p(".env.local")]: "VITE_CRUMBTRAIL_KEY=ctkey_test\n",
  });

  function amendPlanFor(files: Record<string, string>) {
    return buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
        serviceName: "web",
        options: { force: true },
      },
      fakeInjectIO(files),
    );
  }

  // `remoteConfig` is absent from these files and stays absent: it defaults to
  // on, so writing it would be a line that changes nothing.
  it("adds only the absent options and leaves every other byte alone", () => {
    const files = amendableFiles();
    const before = files[p("src", "main.tsx")];
    const plan = amendPlanFor(files);

    expect(plan.kind).toBe("amend-init");
    expect(plan.targetPath).toBe(p("src", "main.tsx"));
    expect(plan.content).toBe(
      [
        'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
        "",
        "Crumbtrail.init({",
        "  ...PRESET_PASSIVE,",
        `  httpEndpoint: "${ENDPOINT}",`,
        "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
        '  service: "web",',
        "});",
        "",
        "console.log('app boot');",
      ].join("\n"),
    );
    // Byte-identical outside the inserted line.
    expect(
      plan
        .content!.split("\n")
        .filter((line) => line !== '  service: "web",')
        .join("\n"),
    ).toBe(before);
  });

  it("never rewrites an option the customer already set", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      `  httpEndpoint: "${ENDPOINT}",`,
      '  httpEndpoint: "https://ingest.customer.internal",',
    );
    const plan = amendPlanFor(files);

    expect(plan.content).toContain(
      '  httpEndpoint: "https://ingest.customer.internal",',
    );
    expect(plan.content).not.toContain(ENDPOINT);
    expect(plan.warnings.join(" ")).toContain("already sets `httpEndpoint`");
  });

  it("never writes an ingest key into the source", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,\n",
      "",
    );
    const plan = amendPlanFor(files);

    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expect(plan.content).not.toContain("ctkey_test");
  });

  it("names the app the source already declares rather than renaming it", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      "});",
      '  remoteConfig: true,\n  service: "asiniq-admin",\n});',
    );
    const plan = amendPlanFor(files);

    expect(plan.kind).toBe("fallback-ai");
    expect(plan.content).toBeNull();
    expect(plan.warnings.join(" ")).toContain(
      "already reports as `asiniq-admin`",
    );
    expect(plan.warnings.join(" ")).toContain("Leaving your name in place");
  });

  it("refuses to guess at an init it cannot enumerate", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      "  ...PRESET_PASSIVE,",
      "  ...customerDefaults,",
    );
    const plan = amendPlanFor(files);

    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toContain("Next:");
  });
});
