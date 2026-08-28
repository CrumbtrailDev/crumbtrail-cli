import { describe, expect, it } from "vitest";
import path from "node:path";
import { inspectIntegration } from "../inject/integration";
import { buildPlan } from "../inject/recipes";
import { envLoadCaveat } from "../cli";
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
