import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  harvestEnvNames,
  inspectIntegration,
  reachableSourceFiles,
} from "../inject/integration";
import { buildPlan } from "../inject/recipes";
import { materializePlan } from "../inject/executor";
import { envLoadCaveat } from "../cli";
import { fakeInjectIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const p = (...parts: string[]) => path.join(CWD, ...parts);
const FIXTURES = path.resolve(__dirname, "../../../../test-fixtures/cli-1");

function fixtureFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[file] = readFileSync(file, "utf8");
    }
  };
  visit(root);
  return files;
}

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
  it.each([
    ["./worker.mjs", "worker.mts"],
    ["./worker.cjs", "worker.cts"],
  ])("maps emitted import %s back to source %s", (specifier, sourceFile) => {
    const files = {
      [p("src", "index.ts")]: `import ${JSON.stringify(specifier)}`,
      [p("src", sourceFile)]: "export const worker = true",
    };
    const reachable = reachableSourceFiles({
      cwd: CWD,
      recipe: "node",
      endpoint: ENDPOINT,
      entryFile: p("src", "index.ts"),
      io: fakeInjectIO(files),
    });
    expect(reachable.map((entry) => entry.file)).toContain(
      p("src", sourceFile),
    );
  });

  it("prefers TypeScript source over emitted JavaScript from a TypeScript importer", () => {
    const reachable = reachableSourceFiles({
      cwd: CWD,
      recipe: "node",
      endpoint: ENDPOINT,
      entryFile: p("src", "index.ts"),
      io: fakeInjectIO({
        [p("src", "index.ts")]: 'import "./worker.js"',
        [p("src", "worker.js")]: "generated()",
        [p("src", "worker.ts")]: "source()",
      }),
    });
    expect(reachable.map((entry) => entry.file)).toContain(
      p("src", "worker.ts"),
    );
    expect(reachable.map((entry) => entry.file)).not.toContain(
      p("src", "worker.js"),
    );
  });

  it("requires complete endpoint, key, service and remote configuration evidence", () => {
    const status = inspectIntegration({
      cwd: CWD,
      recipe: "vite-spa",
      endpoint: ENDPOINT,
      entryFile: p("src", "main.tsx"),
      serviceName: "web",
      io: fakeInjectIO(completeBrowserFiles()),
    });

    expect(status).toEqual({
      complete: true,
      found: true,
      missingSdkPackages: [],
      missing: [],
      hazards: [],
      existingEnvVars: ["VITE_CRUMBTRAIL_KEY"],
      keyEnvVarsSeen: ["VITE_CRUMBTRAIL_KEY"],
      endpointEnvVarsSeen: [],
    });
  });

  it("does not find a Crumbtrail integration in comments or unrelated strings", () => {
    const status = inspectIntegration({
      cwd: CWD,
      recipe: "vite-spa",
      endpoint: ENDPOINT,
      entryFile: p("src", "main.tsx"),
      serviceName: "web",
      io: fakeInjectIO({
        [p("package.json")]: JSON.stringify({
          dependencies: { "crumbtrail-core": "0.49.0" },
        }),
        [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
        [p("src", "main.tsx")]: [
          '// import { Crumbtrail } from "crumbtrail-core";',
          'const config = { package: "crumbtrail-core" };',
          'const message = "require(\\"crumbtrail-node\\")";',
        ].join("\n"),
      }),
    });

    expect(status.found).toBe(false);
    expect(status.missing).toContain("entry");
  });

  it("harvests customer env names from source and setup files without reading config values", () => {
    const files = {
      [p("src", "main.tsx")]: "export const app = true;",
      [p(".env.example")]:
        "VITE_CRUMBTRAIL_ENDPOINT=https://customer.example.com\nVITE_CRUMBTRAIL_API_KEY=secret-value\n",
      [p(".env.production")]: "CRUMBTRAIL_PRODUCTION_KEY=production-secret\n",
      [p("docker-compose.dokploy.yml")]:
        "environment:\n  VITE_CRUMBTRAIL_API_KEY: ${VITE_CRUMBTRAIL_API_KEY}\n",
      [p("Dockerfile")]: "ARG VITE_CRUMBTRAIL_ENDPOINT\n",
      [p("fly.toml")]: "CRUMBTRAIL_TOKEN=not-read\n",
      [p("render.yaml")]: "CRUMBTRAIL_ENDPOINT: https://render.example.com\n",
      [p("vercel.json")]: '{"CRUMBTRAIL_API_KEY":"not-read"}',
      [p("netlify.toml")]: "CRUMBTRAIL_KEY = 'not-read'\n",
      [p("README.md")]: "Set CRUMBTRAIL_README_TOKEN before starting.\n",
    };

    expect(
      harvestEnvNames({
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
        io: fakeInjectIO(files),
      }),
    ).toEqual([
      "VITE_CRUMBTRAIL_ENDPOINT",
      "VITE_CRUMBTRAIL_API_KEY",
      "CRUMBTRAIL_PRODUCTION_KEY",
      "CRUMBTRAIL_README_TOKEN",
      "CRUMBTRAIL_TOKEN",
      "CRUMBTRAIL_KEY",
      "CRUMBTRAIL_ENDPOINT",
      "CRUMBTRAIL_API_KEY",
    ]);
  });

  it("reports every uncertainty in an env gated transport integration", () => {
    const files = {
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-core": "0.47.0" },
      }),
      [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
      [p("src", "main.tsx")]:
        'import { initCrumbtrail } from "./lib/crumbtrail.js";\ninitCrumbtrail();\n',
      [p("src", "lib", "crumbtrail.js")]: [
        "const ENDPOINT = import.meta.env.VITE_CRUMBTRAIL_ENDPOINT;",
        "const API_KEY = import.meta.env.VITE_CRUMBTRAIL_API_KEY || undefined;",
        "let logger = null;",
        "export async function initCrumbtrail() {",
        "  if (logger || !ENDPOINT) return logger;",
        '  try {\n    const { Crumbtrail, HttpTransport } = await import("crumbtrail-core");',
        "    logger = Crumbtrail.init({",
        "      transportInstance: new HttpTransport(ENDPOINT, { authToken: API_KEY }),",
        "      httpEndpoint: ENDPOINT,",
        "      httpAuthToken: API_KEY,",
        "      widget: false,",
        "    });",
        "  } catch (err) {",
        "    console.error(err);",
        "  }",
        "  return logger;",
        "}",
      ].join("\n"),
      [p(".env.example")]:
        "VITE_CRUMBTRAIL_ENDPOINT=https://customer.example.com\nVITE_CRUMBTRAIL_API_KEY=customer-secret\n",
    };
    const input = {
      cwd: CWD,
      recipe: "vite-spa" as const,
      endpoint: ENDPOINT,
      entryFile: p("src", "main.tsx"),
      serviceName: "web",
      io: fakeInjectIO(files),
    };
    const status = inspectIntegration(input);
    expect(status.hazards).toEqual([
      "guarded-init",
      "transport-instance",
      "other-key-channel",
    ]);
    expect(status.keyEnvVarsSeen).toEqual(["VITE_CRUMBTRAIL_API_KEY"]);
    expect(status.endpointEnvVarsSeen).toEqual(["VITE_CRUMBTRAIL_ENDPOINT"]);

    const plan = buildPlan(
      { ...input, options: { force: true } },
      fakeInjectIO(files),
    );
    expect(plan.kind).toBe("needs-hands");
    expect(plan.content).toBeNull();
    expect(plan.integration?.existingEnvVars).toEqual([
      "VITE_CRUMBTRAIL_ENDPOINT",
      "VITE_CRUMBTRAIL_API_KEY",
    ]);
    expect(plan.integration?.file).toBe(p("src", "lib", "crumbtrail.js"));
    expect(plan.integration?.instructions.join(" ")).toContain(
      "transportInstance",
    );
  });

  it("refuses both sides of the taskflow shaped monorepo without source edits", () => {
    const clientRoot = path.join(FIXTURES, "taskflow-client");
    const serverRoot = path.join(FIXTURES, "taskflow-server");
    const files = {
      ...fixtureFiles(clientRoot),
      ...fixtureFiles(serverRoot),
    };
    const clientPlan = buildPlan(
      {
        cwd: clientRoot,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: path.join(clientRoot, "src", "main.tsx"),
        serviceName: "web",
        options: { force: true },
      },
      fakeInjectIO(files),
    );
    const serverPlan = buildPlan(
      {
        cwd: serverRoot,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: path.join(serverRoot, "src", "index.js"),
        serviceName: "api",
        options: { force: true },
      },
      fakeInjectIO(files),
    );

    expect(clientPlan.kind).toBe("needs-hands");
    expect(serverPlan.kind).toBe("needs-hands");
    expect(clientPlan.content).toBeNull();
    expect(serverPlan.content).toBeNull();
    // Each half names every reason it is unsafe. The server reaches its
    // middleware through a function behind an endpoint check and a dynamic
    // import, which is the same unknown startup path as the client's.
    expect(clientPlan.integration?.hazards).toEqual([
      "guarded-init",
      "transport-instance",
      "other-key-channel",
    ]);
    expect(serverPlan.integration?.hazards).toEqual([
      "guarded-init",
      "other-key-channel",
    ]);
    expect(clientPlan.integration?.existingEnvVars).toEqual([
      "VITE_CRUMBTRAIL_ENDPOINT",
      "VITE_CRUMBTRAIL_API_KEY",
    ]);
    expect(serverPlan.integration?.existingEnvVars).toEqual([
      "CRUMBTRAIL_ENDPOINT",
      "CRUMBTRAIL_API_KEY",
    ]);
    const materialized = materializePlan(clientPlan, {
      exists: () => true,
      readFile: () => null,
      writeFile: () => {},
      mkdirp: () => {},
      remove: () => {},
    });
    expect(materialized.edits).toEqual([]);
    expect(materialized.integration).toEqual(clientPlan.integration);
  });

  it("refuses an Express middleware service option and gives the autoCapture path", () => {
    const source = [
      'import { createCrumbtrailExpressMiddleware } from "crumbtrail-node";',
      "const ENDPOINT = process.env.CRUMBTRAIL_ENDPOINT;",
      "createCrumbtrailExpressMiddleware({",
      "  endpoint: ENDPOINT,",
      "  authToken: process.env.CRUMBTRAIL_KEY,",
      "});",
    ].join("\n");
    const files = {
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-node": "0.47.0" },
      }),
      [p("node_modules", "crumbtrail-node", "package.json")]: "{}",
      [p("src", "index.js")]: source,
      [p(".env")]:
        "CRUMBTRAIL_ENDPOINT=https://ingest.example.com\nCRUMBTRAIL_KEY=customer-key\n",
    };
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.js"),
        serviceName: "api",
        options: { force: true },
      },
      fakeInjectIO(files),
    );

    expect(plan.kind).toBe("needs-hands");
    expect(plan.content).toBeNull();
    expect(plan.integration?.blocked).toContainEqual({
      requirement: "service-name",
      reason: "unsupported-here",
    });
    expect(plan.integration?.instructions.join(" ")).toContain(
      "autoCapture({ service })",
    );
    expect(plan.integration?.instructions.join(" ")).not.toContain("service:");
  });

  describe("guarded-init", () => {
    const hazardsFor = (
      source: string,
      recipe: "vite-spa" | "express" | "nuxt" = "vite-spa",
      entry = p("src", "main.tsx"),
    ) =>
      inspectIntegration({
        cwd: CWD,
        recipe,
        endpoint: ENDPOINT,
        entryFile: entry,
        serviceName: "web",
        io: fakeInjectIO({
          [p("package.json")]: JSON.stringify({
            dependencies: {
              "crumbtrail-core": "0.47.0",
              "crumbtrail-node": "0.47.0",
            },
          }),
          [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
          [p("node_modules", "crumbtrail-node", "package.json")]: "{}",
          [entry]: source,
        }),
      }).hazards;

    it("flags a top level init that only runs behind a condition", () => {
      expect(
        hazardsFor(
          'import { Crumbtrail } from "crumbtrail-core";\n' +
            "if (import.meta.env.PROD) Crumbtrail.init({\n" +
            `  httpEndpoint: "${ENDPOINT}",\n` +
            "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,\n" +
            "});\n",
        ),
      ).toContain("guarded-init");
    });

    it("flags an init only a dynamic import inside a function reaches", () => {
      expect(
        hazardsFor(
          "export async function boot() {\n" +
            '  const { Crumbtrail } = await import("crumbtrail-core");\n' +
            `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY });\n` +
            "}\n",
        ),
      ).toContain("guarded-init");
    });

    it("flags a top level try, which is still a startup path this cannot see", () => {
      expect(
        hazardsFor(
          "try {\n" +
            `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY });\n` +
            "} catch {}\n",
        ),
      ).toContain("guarded-init");
    });

    it("leaves a plain top level init alone", () => {
      expect(
        hazardsFor(
          'import { Crumbtrail } from "crumbtrail-core";\n' +
            "Crumbtrail.init({\n" +
            `  httpEndpoint: "${ENDPOINT}",\n` +
            "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,\n" +
            "});\n",
        ),
      ).toEqual([]);
    });

    // A run that refused the wiring it wrote itself would make the wizard
    // unrepeatable. Both of these are exactly what the injector emits.
    it("leaves this CLI's own key guarded Express wiring alone", () => {
      expect(
        hazardsFor(
          'import { createCrumbtrailExpressMiddleware } from "crumbtrail-node";\n' +
            "if (process.env.CRUMBTRAIL_KEY) app.use(createCrumbtrailExpressMiddleware({ " +
            `endpoint: "${ENDPOINT}", authToken: process.env.CRUMBTRAIL_KEY, service: undefined }));\n`,
          "express",
          p("src", "index.js"),
        ),
      ).not.toContain("guarded-init");
    });

    it("leaves this CLI's own Nuxt plugin body alone", () => {
      expect(
        hazardsFor(
          'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";\n\n' +
            "export default defineNuxtPlugin(() => {\n" +
            "  Crumbtrail.init({\n" +
            "    ...PRESET_PASSIVE,\n" +
            `    httpEndpoint: "${ENDPOINT}",\n` +
            "    httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,\n" +
            "  });\n" +
            "});\n",
          "nuxt",
          p("plugins", "crumbtrail.client.ts"),
        ),
      ).toEqual([]);
    });
  });

  describe("other-key-channel", () => {
    const viteHazards = (source: string, envExample: string) =>
      inspectIntegration({
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
        serviceName: "web",
        io: fakeInjectIO({
          [p("package.json")]: JSON.stringify({
            dependencies: { "crumbtrail-core": "0.47.0" },
          }),
          [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
          [p("src", "main.tsx")]: source,
          [p(".env.example")]: envExample,
        }),
      }).hazards;

    const init = (token: string) =>
      'import { Crumbtrail } from "crumbtrail-core";\n' +
      `Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: ${token}, service: "web" });\n`;

    it("accepts the key expression this recipe would have written itself", () => {
      expect(
        viteHazards(
          init("import.meta.env.VITE_CRUMBTRAIL_KEY"),
          "VITE_CRUMBTRAIL_KEY=\n",
        ),
      ).toEqual([]);
    });

    it("flags a key read through any other expression", () => {
      expect(
        viteHazards(init("window.__KEY"), "VITE_CRUMBTRAIL_KEY=\n"),
      ).toEqual(["other-key-channel"]);
    });

    // The taskflow name. Pasting this run's key into VITE_CRUMBTRAIL_KEY would
    // leave the variable the customer's build actually reads unset.
    it("flags a second Crumbtrail key variable the project already names", () => {
      expect(
        viteHazards(
          init("import.meta.env.VITE_CRUMBTRAIL_KEY"),
          "VITE_CRUMBTRAIL_ENDPOINT=\nVITE_CRUMBTRAIL_API_KEY=\n",
        ),
      ).toEqual(["other-key-channel"]);
    });
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
    expect(plan.integration).toMatchObject({
      found: true,
      amended: true,
      amendedFields: ["service"],
      existingEnvVars: ["VITE_CRUMBTRAIL_KEY"],
      file: p("src", "main.tsx"),
    });
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

  it("refuses a partial amend when an existing option disagrees", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      `  httpEndpoint: "${ENDPOINT}",`,
      '  httpEndpoint: "https://ingest.customer.internal",',
    );
    const plan = amendPlanFor(files);

    expect(plan.kind).toBe("needs-hands");
    expect(plan.content).toBeNull();
    expect(plan.integration?.blocked).toEqual([
      {
        requirement: "endpoint",
        existingKey: "httpEndpoint",
        existingValue: '"https://ingest.customer.internal"',
        reason: "already-set",
      },
    ]);
    expect(plan.integration?.instructions.join(" ")).toContain(
      "already sets `httpEndpoint`",
    );
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

    expect(plan.kind).toBe("needs-hands");
    expect(plan.content).toBeNull();
    expect(plan.integration?.instructions.join(" ")).toContain(
      "already reports as `asiniq-admin`",
    );
    expect(plan.integration?.instructions.join(" ")).toContain(
      "Leaving your name in place",
    );
  });

  it("refuses to guess at an init it cannot enumerate", () => {
    const files = amendableFiles();
    files[p("src", "main.tsx")] = files[p("src", "main.tsx")].replace(
      "  ...PRESET_PASSIVE,",
      "  ...customerDefaults,",
    );
    const plan = amendPlanFor(files);

    expect(plan.kind).toBe("needs-hands");
    expect(plan.content).toBeNull();
    expect(plan.integration?.blocked[0]?.reason).toBe("unparsable");
    expect(plan.integration?.instructions.join(" ")).toContain("Next:");
  });
});

describe("an amended service reads the key the wizard just wrote", () => {
  // The fresh-injection path prepends a guarded env file load above the init it
  // writes, so the key in `.env` is set before anything reads it. The amend
  // path skipped it, which made the amended service the one case where the
  // wizard wrote a key the service never read while every line after reported
  // a finished setup.
  function nodeFiles(over: Record<string, string> = {}) {
    return {
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-node": "0.41.0" },
      }),
      [p("node_modules", "crumbtrail-node", "package.json")]: "{}",
      [p("src", "index.js")]: [
        'import { autoCapture } from "crumbtrail-node";',
        "",
        "autoCapture({",
        `  endpoint: "${ENDPOINT}",`,
        "  authToken: process.env.CRUMBTRAIL_KEY,",
        "});",
        "",
        "console.log('server boot');",
      ].join("\n"),
      ...over,
    };
  }

  const nodeAmendPlan = (files: Record<string, string>) =>
    buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.js"),
        serviceName: "api",
        options: { force: true },
      },
      fakeInjectIO(files),
    );

  it("prepends the same guarded env load the fresh path writes", () => {
    const plan = nodeAmendPlan(nodeFiles());

    expect(plan.kind).toBe("amend-init");
    expect(plan.content).toContain("loadEnvFile");
    expect(plan.content).toContain("Crumbtrail");
    expect(plan.envPreloadAdded).toBe(true);
    // The customer's own init is still theirs, with the one option added.
    expect(plan.content).toContain('service: "api"');
    expect(plan.content).toContain("console.log('server boot')");
    // The load has to come first, or the init reads the variable before
    // anything set it.
    expect(plan.content!.indexOf("loadEnvFile")).toBeLessThan(
      plan.content!.indexOf("autoCapture({"),
    );
  });

  it("names the second edit rather than promising nothing else changed", () => {
    const plan = nodeAmendPlan(nodeFiles());
    const warning = plan.warnings.join(" ");
    expect(warning).toContain("prepended a guarded env file load");
    expect(warning).toContain("CRUMBTRAIL_KEY");
  });

  it("silences the caveat that existed only because this was missing", () => {
    // envLoadCaveat self-suppresses for a file that loads an env file. With
    // the prepend in place there is no condition left to state, so the line
    // has to go quiet on its own.
    const plan = nodeAmendPlan(nodeFiles());
    expect(
      envLoadCaveat({ content: plan.content, keyEnvVar: plan.keyEnvVar }),
    ).toBeUndefined();
  });

  it("adds no second loader to a file that already loads one", () => {
    const files = nodeFiles();
    files[p("src", "index.js")] = files[p("src", "index.js")].replace(
      'import { autoCapture } from "crumbtrail-node";',
      'import "dotenv/config";\nimport { autoCapture } from "crumbtrail-node";',
    );
    const plan = nodeAmendPlan(files);
    expect(plan.kind).toBe("amend-init");
    expect(plan.content).not.toContain("loadEnvFile");
    expect(plan.envPreloadAdded).toBeUndefined();
    expect(plan.warnings.join(" ")).not.toContain("prepended a guarded");
  });

  it("leaves a bundler-inlined key alone, which no runtime read depends on", () => {
    // A Vite key is substituted at build time by a build that reads `.env`
    // itself, so there is no runtime read for a loader to get ahead of.
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
        serviceName: "web",
        options: { force: true },
      },
      fakeInjectIO({
        [p("package.json")]: JSON.stringify({
          dependencies: { "crumbtrail-core": "0.41.0" },
        }),
        [p("node_modules", "crumbtrail-core", "package.json")]: "{}",
        [p("src", "main.tsx")]: [
          'import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";',
          "Crumbtrail.init({",
          "  ...PRESET_PASSIVE,",
          `  httpEndpoint: "${ENDPOINT}",`,
          "  httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY,",
          "});",
        ].join("\n"),
      }),
    );
    expect(plan.kind).toBe("amend-init");
    expect(plan.content).not.toContain("loadEnvFile");
  });
});

describe("SDK packages an adapter already implies", () => {
  const serverFiles = (
    dependencies: Record<string, string>,
    installed: string[],
  ): Record<string, string> => ({
    [p("package.json")]: JSON.stringify({ dependencies }),
    ...Object.fromEntries(
      installed.map((name) => [
        p("node_modules", name, "package.json"),
        "{}",
      ]),
    ),
    [p("server.js")]: [
      'import { autoCapture } from "crumbtrail-node";',
      "autoCapture({",
      `  httpEndpoint: "${ENDPOINT}",`,
      "  httpAuthToken: process.env.CRUMBTRAIL_KEY,",
      '  service: "api",',
      "});",
    ].join("\n"),
    [p(".env")]: "CRUMBTRAIL_KEY=ctkey_test\n",
  });

  const inspect = (files: Record<string, string>) =>
    inspectIntegration({
      cwd: CWD,
      recipe: "express",
      endpoint: ENDPOINT,
      entryFile: p("server.js"),
      serviceName: "api",
      io: fakeInjectIO(files),
    });

  it("treats a declared crumbtrail-node as supplying crumbtrail-core", () => {
    const status = inspect(
      serverFiles({ "crumbtrail-node": "^0.47.0" }, ["crumbtrail-node"]),
    );
    expect(status.missing).not.toContain("sdk");
    expect(status.missingSdkPackages).toEqual([]);
  });

  it("does not let a pre-lockstep crumbtrail-node imply crumbtrail-core", () => {
    const status = inspect(
      serverFiles({ "crumbtrail-node": "^0.30.0" }, ["crumbtrail-node"]),
    );
    expect(status.missing).toContain("sdk");
    expect(status.missingSdkPackages).toEqual(["crumbtrail-core"]);
  });

  it("still requires the adapter itself to be installed", () => {
    const status = inspect(serverFiles({ "crumbtrail-node": "^0.47.0" }, []));
    expect(status.missingSdkPackages).toEqual([
      "crumbtrail-core",
      "crumbtrail-node",
    ]);
  });

  it("reports only the package the manifest is short of", () => {
    const status = inspect(
      serverFiles({ "crumbtrail-core": "^0.47.0" }, ["crumbtrail-core"]),
    );
    expect(status.missingSdkPackages).toEqual(["crumbtrail-node"]);
  });

  it("names only the shortfall in the guidance, and agrees on it/them", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "api",
      },
      fakeInjectIO(
        serverFiles({ "crumbtrail-core": "^0.47.0" }, ["crumbtrail-core"]),
      ),
    );
    const guidance = (plan.warnings ?? []).join("\n");
    expect(guidance).toContain("Next: Install crumbtrail-node (");
    expect(guidance).toContain("adds it for you");
    expect(guidance).not.toContain("crumbtrail-core, crumbtrail-node");
  });
});
