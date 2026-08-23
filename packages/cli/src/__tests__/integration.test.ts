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
    expect(status.missing).toEqual([
      "endpoint",
      "ingest-key",
      "service-name",
      "remote-config",
    ]);
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
    expect(plan.warnings.join(" ")).toContain("will not add another initialization");
    expect(plan.warnings.join(" ")).toContain("the install endpoint");
  });
});

