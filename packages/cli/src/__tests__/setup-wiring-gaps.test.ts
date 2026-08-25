// The three gaps between "the wizard reported success" and "this deployment
// actually reports": the entry read its key before anything loaded .env, the
// second process the package starts was never touched, and the Docker build
// that bakes the key into the bundle never received it.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan } from "../inject/recipes";
import { executePlan, materializePlan } from "../inject/executor";
import {
  findExtraBackendEntries,
  serviceSuffixFor,
} from "../inject/entrypoints";
import { addDockerBuildArg } from "../inject/docker";
import { fakeInjectIO, memExecutorIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const p = (...parts: string[]) => path.join(CWD, ...parts);

const PKG = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "app", scripts });

describe("env is loaded before the key is read", () => {
  it("puts the .env preload above the init block for the generic node recipe", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "index.ts")]: "startServer();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
      },
      io,
    );
    const content = plan.content ?? "";
    expect(content).toContain("if (!process.env.CRUMBTRAIL_KEY) {");
    // Ordering is the whole point: a preload below the init is no preload.
    expect(content.indexOf("if (!process.env.CRUMBTRAIL_KEY) {")).toBeLessThan(
      content.indexOf('import("crumbtrail-node")'),
    );
  });

  it("emits the preload in single quotes for Nest, matching its Prettier config", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "bootstrap();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "nestjs",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.content).toContain(
      "for (const envFile of ['.env', '.env.local'])",
    );
    expect(plan.content).not.toContain('".env"');
  });

  it("still leads the Express block with the preload", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("index.js")]: [
        'const express = require("express");',
        "const app = express();",
        "app.listen(3000);",
      ].join("\n"),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("index.js"),
      },
      io,
    );
    const content = plan.content ?? "";
    expect(content.indexOf("if (!process.env.CRUMBTRAIL_KEY) {")).toBeLessThan(
      content.indexOf('import("crumbtrail-node")'),
    );
  });
});

describe("the other processes the package starts", () => {
  const workerFiles = {
    [p("package.json")]: PKG({
      start: "tsx src/index.ts",
      worker: "tsx src/worker.ts",
      build: "tsc -p tsconfig.json",
    }),
    [p("src", "index.ts")]: "startServer();\n",
    [p("src", "worker.ts")]: "runQueue();\n",
  };

  it("wires the worker as its own service", () => {
    const io = fakeInjectIO(workerFiles);
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    expect(plan.extraEdits).toHaveLength(1);
    const [edit] = plan.extraEdits!;
    expect(edit.path).toBe(p("src", "worker.ts"));
    expect(edit.mode).toBe("update");
    expect(edit.content).toContain('service: "marginary-worker"');
    // The worker's own body survives; this is a prepend, not a replacement.
    expect(edit.content).toContain("runQueue();");
    // And it gets the same env preload the entry gets.
    expect(edit.content).toContain("if (!process.env.CRUMBTRAIL_KEY) {");
  });

  it("labels the service by directory when the file name is generic", () => {
    expect(serviceSuffixFor("/proj/src/worker.ts")).toBe("worker");
    expect(serviceSuffixFor("/proj/queue/index.ts")).toBe("queue");
    expect(serviceSuffixFor("/proj/cron/main.js")).toBe("cron");
  });

  it("skips a worker that is already wired", () => {
    const io = fakeInjectIO({
      ...workerFiles,
      [p("src", "worker.ts")]: 'import("crumbtrail-node");\nrunQueue();\n',
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
  });

  it("leaves a dirty worker alone and says so", () => {
    const io = fakeInjectIO(workerFiles, { dirty: [p("src", "worker.ts")] });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
    expect(plan.warnings.join(" ")).toContain("uncommitted changes");
    expect(plan.warnings.join(" ")).toContain("worker.ts");
  });

  it("wires a dirty worker under force", () => {
    const io = fakeInjectIO(workerFiles, { dirty: [p("src", "worker.ts")] });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
        options: { force: true },
      },
      io,
    );
    expect(plan.extraEdits).toHaveLength(1);
  });

  it("still wires the worker when the entry is already complete", () => {
    // "Already wired" is a statement about the entry, never about the worker.
    const io = fakeInjectIO({
      ...workerFiles,
      [p("package.json")]: JSON.stringify({
        name: "app",
        dependencies: { "crumbtrail-node": "^0.37.0" },
        scripts: { start: "tsx src/index.ts", worker: "tsx src/worker.ts" },
      }),
      [p("node_modules", "crumbtrail-node", "package.json")]: "{}",
      [p("src", "index.ts")]: [
        'import("crumbtrail-node").then(({ autoCapture }) =>',
        `  autoCapture({ endpoint: "${ENDPOINT}", authToken: process.env.CRUMBTRAIL_KEY, service: "marginary" }),`,
        ");",
      ].join("\n"),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(1);

    // And the executor writes it rather than reporting a clean skip.
    const { io: exec, files } = memExecutorIO({
      [p("src", "worker.ts")]: "runQueue();\n",
    });
    const result = executePlan(plan, exec);
    expect(result.written).toEqual([p("src", "worker.ts")]);
    expect(files[p("src", "worker.ts")]).toContain("marginary-worker");
  });

  it("ignores build, test and config files named in scripts", () => {
    const io = fakeInjectIO({
      [p("package.json")]: PKG({
        start: "tsx src/index.ts",
        build: "tsx scripts/build.ts",
        test: "vitest run src/thing.test.ts",
        lint: "eslint --config eslint.config.mjs .",
        preview: "vite preview --config vite.config.ts",
      }),
      [p("src", "index.ts")]: "startServer();\n",
      [p("scripts", "build.ts")]: "",
      [p("src", "thing.test.ts")]: "",
      [p("eslint.config.mjs")]: "",
      [p("vite.config.ts")]: "",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
  });

  it("names the processes it left unwired rather than counting them", () => {
    const scripts: Record<string, string> = { start: "tsx src/index.ts" };
    const files: Record<string, string> = {
      [p("src", "index.ts")]: "startServer();\n",
    };
    for (let i = 0; i < 6; i++) {
      scripts[`job${i}`] = `tsx src/job${i}.ts`;
      files[p("src", `job${i}.ts`)] = "run();\n";
    }
    files[p("package.json")] = PKG(scripts);
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
      },
      fakeInjectIO(files),
    );
    expect(plan.extraEdits).toHaveLength(4);
    const warned = plan.warnings.join(" ");
    expect(warned).toContain("these were left unwired");
    // Every unwired process is named with its file and the script that runs it,
    // so the user can finish the job without re-deriving the scan.
    const named = [4, 5].map((i) =>
      warned.includes(`src/job${i}.ts (npm run job${i})`),
    );
    expect(named).toEqual([true, true]);
  });

  it("spends its slots on long running processes, not one shot scripts", () => {
    const files: Record<string, string> = {
      [p("package.json")]: PKG({
        start: "tsx api/src/index.ts",
        worker: "tsx api/src/worker.ts",
        migrate: "tsx migrate.ts",
        seed: "tsx seedSim.ts",
        "stripe:bootstrap": "tsx stripeBootstrap.ts",
        sim: "tsx sim/server.ts",
      }),
      [p("api", "src", "index.ts")]: "startServer();\n",
      [p("api", "src", "worker.ts")]: "runQueue();\n",
      [p("migrate.ts")]: "migrate();\n",
      [p("seedSim.ts")]: "seed();\n",
      [p("stripeBootstrap.ts")]: "bootstrap();\n",
      [p("sim", "server.ts")]: "serve();\n",
      [p("railway.worker.json")]: JSON.stringify({
        deploy: { startCommand: "npm run worker" },
      }),
    };
    const io = fakeInjectIO(files);
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("api", "src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    const wired = (plan.extraEdits ?? []).map((e) => e.path);
    expect(wired).toContain(p("api", "src", "worker.ts"));
    // The one that lost its slot is a script that exits, not the worker.
    expect(plan.warnings.join(" ")).not.toContain("worker.ts (npm run worker)");
  });

  it("finds nothing when the package declares no scripts", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    expect(
      findExtraBackendEntries(CWD, io, p("src", "index.ts")).entries,
    ).toEqual([]);
  });

  it("does not look for extra processes on a frontend recipe", () => {
    const io = fakeInjectIO({
      [p("package.json")]: PKG({ worker: "tsx src/worker.ts" }),
      [p("src", "main.tsx")]: "render();\n",
      [p("src", "worker.ts")]: "runQueue();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
  });
});

describe("the key the bundler bakes in", () => {
  const DOCKERFILE = [
    "FROM node:22-alpine AS build",
    "WORKDIR /app",
    "ARG VITE_API_URL",
    "ARG VITE_SENTRY_DSN",
    "ENV VITE_API_URL=$VITE_API_URL",
    "ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN",
    "RUN npm run build",
    "",
    "FROM nginx:alpine",
    "COPY --from=build /app/dist /usr/share/nginx/html",
    "",
  ].join("\n");

  it("adds the ARG and its ENV mirror beside the siblings", () => {
    const result = addDockerBuildArg(DOCKERFILE, "VITE_CRUMBTRAIL_KEY");
    expect(result.changed).toBe(true);
    expect(result.mirroredEnv).toBe(true);
    const lines = result.text.split("\n");
    expect(lines).toContain("ARG VITE_CRUMBTRAIL_KEY");
    expect(lines).toContain("ENV VITE_CRUMBTRAIL_KEY=$VITE_CRUMBTRAIL_KEY");
    // In the build stage, not the nginx one — an ARG in the serving stage is as
    // invisible as no ARG at all.
    expect(lines.indexOf("ARG VITE_CRUMBTRAIL_KEY")).toBeLessThan(
      lines.indexOf("FROM nginx:alpine"),
    );
    expect(
      lines.indexOf("ENV VITE_CRUMBTRAIL_KEY=$VITE_CRUMBTRAIL_KEY"),
    ).toBeLessThan(lines.indexOf("FROM nginx:alpine"));
  });

  it("adds only the ARG when the siblings have no ENV mirror", () => {
    const text = [
      "FROM node:22",
      "ARG VITE_API_URL",
      "RUN npm run build",
      "",
    ].join("\n");
    const result = addDockerBuildArg(text, "VITE_CRUMBTRAIL_KEY");
    expect(result.changed).toBe(true);
    expect(result.mirroredEnv).toBe(false);
    expect(result.text).not.toContain("ENV VITE_CRUMBTRAIL_KEY");
  });

  it("changes nothing when the ARG is already declared", () => {
    const text = `FROM node:22\nARG VITE_API_URL\nARG VITE_CRUMBTRAIL_KEY\n`;
    const result = addDockerBuildArg(text, "VITE_CRUMBTRAIL_KEY");
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("already-declared");
    expect(result.text).toBe(text);
  });

  it("refuses to guess when the Dockerfile passes no build args of this prefix", () => {
    const text = `FROM node:22\nRUN npm run build\n`;
    const result = addDockerBuildArg(text, "VITE_CRUMBTRAIL_KEY");
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("no-sibling-args");
  });

  it("carries the Dockerfile edit on the Vite plan", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.tsx")]: "render();\n",
      [p("Dockerfile")]: DOCKERFILE,
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.extraEdits).toHaveLength(1);
    expect(plan.extraEdits![0].path).toBe(p("Dockerfile"));
    expect(plan.extraEdits![0].content).toContain("ARG VITE_CRUMBTRAIL_KEY");

    // Both files land, and the entry edit is still a prepend into the original.
    const { io: exec, files } = memExecutorIO({
      [p("src", "main.tsx")]: "render();\n",
      [p("Dockerfile")]: DOCKERFILE,
    });
    executePlan(plan, exec);
    expect(files[p("Dockerfile")]).toContain("ARG VITE_CRUMBTRAIL_KEY");
    expect(files[p("src", "main.tsx")]).toContain("render();");
  });

  it("warns instead of editing a Dockerfile with no build args", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.tsx")]: "render();\n",
      [p("Dockerfile")]: "FROM node:22\nRUN npm run build\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
    expect(plan.warnings.join(" ")).toContain("VITE_CRUMBTRAIL_KEY");
    expect(plan.warnings.join(" ")).toContain("Dockerfile");
  });

  it("adds no build arg for a backend key, which is read at run time", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "index.ts")]: "startServer();\n",
      [p("Dockerfile")]:
        'FROM node:22\nARG NODE_ENV\nCMD ["node", "src/index.js"]\n',
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
      },
      io,
    );
    expect(plan.extraEdits ?? []).toHaveLength(0);
  });
});

describe("extra edits go through the executor's all-or-nothing write", () => {
  it("rolls the entry edit back when an extra edit fails", () => {
    const io = fakeInjectIO({
      [p("package.json")]: PKG({
        start: "tsx src/index.ts",
        worker: "tsx src/worker.ts",
      }),
      [p("src", "index.ts")]: "startServer();\n",
      [p("src", "worker.ts")]: "runQueue();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
        serviceName: "marginary",
      },
      io,
    );
    const { io: exec, files } = memExecutorIO(
      {
        [p("src", "index.ts")]: "startServer();\n",
        [p("src", "worker.ts")]: "runQueue();\n",
      },
      p("src", "index.ts"),
    );
    expect(() => executePlan(plan, exec)).toThrow();
    expect(files[p("src", "worker.ts")]).toBe("runQueue();\n");
    expect(files[p("src", "index.ts")]).toBe("startServer();\n");
  });

  it("materializes the extra edits alongside the entry edit", () => {
    const io = fakeInjectIO({
      [p("package.json")]: PKG({
        start: "tsx src/index.ts",
        worker: "tsx src/worker.ts",
      }),
      [p("src", "index.ts")]: "startServer();\n",
      [p("src", "worker.ts")]: "runQueue();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("src", "index.ts"),
      },
      io,
    );
    const { io: exec } = memExecutorIO({
      [p("src", "index.ts")]: "startServer();\n",
      [p("src", "worker.ts")]: "runQueue();\n",
    });
    const materialized = materializePlan(plan, exec);
    expect(materialized.edits.map((e) => e.path).sort()).toEqual(
      [p("src", "index.ts"), p("src", "worker.ts")].sort(),
    );
    for (const edit of materialized.edits) expect(edit.mode).toBe("update");
  });
});
