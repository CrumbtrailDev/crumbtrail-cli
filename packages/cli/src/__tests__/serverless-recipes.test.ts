import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { detect, type Recipe } from "../detect";
import { executePlan } from "../inject/executor";
import { buildPlan } from "../inject/recipes";
import { cleanup, fakeInjectIO, makeTmpRepo, memExecutorIO } from "./helpers";

const fixture = (name: string) =>
  path.resolve(__dirname, `../../../../test-fixtures/installers/${name}`);

describe("serverless runtime precedence", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });

  // Goes red if Wrangler ever falls behind Hono or generic Node.
  it("keeps Wrangler ahead of the Hono backend fallback", () => {
    const result = detect(fixture("cloudflare-hono"));

    expect(result.recipe).toBe("cloudflare-workers");
    expect(result.reasons.join("\n")).toContain("wrangler.jsonc");
  });

  // Goes red if Deno returns to the unsupported path or loses its proven entry.
  it("routes a Deno serve entry to the Fetch adapter recipe", () => {
    const result = detect(fixture("deno-deploy"));

    expect(result.recipe).toBe("deno-deploy");
    expect(result.entryFile).toBe(path.join(fixture("deno-deploy"), "main.ts"));
    expect(result.reasons.join("\n")).toContain("deno.json");
    expect(result.reasons.join("\n")).toContain("main.ts");
  });

  // Goes red if Vercel platform evidence falls behind generic Node.
  it("routes decisive Vercel Node evidence ahead of generic Node", () => {
    const result = detect(fixture("vercel-node"));

    expect(result.recipe).toBe("vercel-functions");
    expect(result.reasons.join("\n")).toContain("vercel.json");
    expect(result.reasons.join("\n")).toContain("nodejs20.x");
  });

  it.each([
    ["aws-serverless", "aws-lambda", "serverless.yml"],
    ["aws-sam", "aws-lambda", "template.yaml"],
    ["vercel-edge", "vercel-edge-functions", "edge"],
    ["netlify-node", "netlify-functions", "netlify/functions/hello.ts"],
    ["netlify-edge", "netlify-edge-functions", "edge"],
  ])("detects %s as %s from %s evidence", (name, recipe, reason) => {
    const result = detect(fixture(name));

    expect(result.recipe).toBe(recipe);
    expect(result.reasons.join("\n")).toContain(reason);
  });

  it.each([
    ["serverless.yml", "provider:\n  name: aws\n"],
    ["serverless.yaml", "provider: aws\n"],
    ["serverless.ts", 'export default { provider: { name: "aws" } };\n'],
  ])("accepts %s only with textual AWS provider evidence", (name, content) => {
    const root = makeTmpRepo({ [name]: content });
    roots.push(root);

    const result = detect(root);
    expect(result.recipe).toBe("aws-lambda");
    expect(result.reasons.join("\n")).toContain(name);
  });

  it.each([
    ["template.yml", "Transform: AWS::Serverless-2016-10-31\n"],
    [
      "template.yaml",
      "Resources:\n  Fn:\n    Type: AWS::Serverless::Function\n",
    ],
    ["template.json", '{"Transform":"AWS::Serverless-2016-10-31"}\n'],
  ])("accepts %s only with AWS SAM evidence", (name, content) => {
    const root = makeTmpRepo({ [name]: content });
    roots.push(root);

    expect(detect(root).recipe).toBe("aws-lambda");
  });

  it.each([
    [
      "Vercel dependency",
      {
        "package.json": JSON.stringify({
          dependencies: { "@vercel/node": "5" },
        }),
      },
      "vercel-functions",
    ],
    [
      "Vercel api directory",
      { "api/hello.ts": "export default () => new Response('ok');\n" },
      "vercel-functions-ambiguous",
    ],
    [
      "Netlify dependency",
      {
        "package.json": JSON.stringify({
          dependencies: { "@netlify/edge-functions": "2" },
        }),
      },
      "netlify-edge-functions",
    ],
    [
      "Netlify function directory",
      {
        "netlify/functions/hello.ts":
          "export const handler = async () => ({ statusCode: 200 });\n",
      },
      "netlify-functions",
    ],
  ])("uses standalone %s evidence", (_label, files, recipe) => {
    const root = makeTmpRepo(files);
    roots.push(root);

    expect(detect(root).recipe).toBe(recipe);
  });

  it.each([
    ["vercel-ambiguous", "vercel-functions-ambiguous"],
    ["netlify-ambiguous", "netlify-functions-ambiguous"],
  ])("keeps %s as a guided runtime choice", (name, recipe) => {
    const result = detect(fixture(name));

    expect(result.recipe).toBe(recipe);
    expect(result.ambiguous).toBe(true);
    expect(result.reasons.join("\n")).toMatch(
      /choose the Node or edge adapter/,
    );
  });

  // Goes red if a generic infrastructure template is mistaken for AWS SAM.
  it("does not classify a generic template.yaml as AWS SAM", () => {
    const root = makeTmpRepo({
      "template.yaml": "Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n",
    });
    roots.push(root);

    expect(detect(root).recipe).toBeNull();
  });

  // Goes red if serverless.ts is executed or accepted without textual AWS proof.
  it("requires textual AWS provider evidence in serverless.ts", () => {
    const root = makeTmpRepo({
      "serverless.ts":
        'throw new Error("must not execute");\nexport default { provider: { name: "gcp" } };\n',
    });
    roots.push(root);

    expect(detect(root).recipe).toBeNull();
  });
});

const CWD = "/project";
const ENDPOINT = "https://ingest.example.com";

function plan(recipe: Recipe) {
  return buildPlan(
    {
      cwd: CWD,
      recipe,
      endpoint: ENDPOINT,
      serviceName: "orders-api",
    },
    fakeInjectIO({}),
  );
}

function guidance(recipe: Recipe): string {
  const value = plan(recipe);
  expect(value.kind).toBe("serverless-guidance");
  expect(value.targetPath).toBeNull();
  expect(value.content).toBeNull();
  expect(value.sdkPackages).toEqual([]);
  expect(value.keyEnvVar).toBeUndefined();
  return value.snippet ?? "";
}

describe("serverless setup guidance", () => {
  it.each([
    ["aws-lambda", "withCrumbtrailAwsLambda"],
    ["vercel-functions", "withCrumbtrailVercel"],
    ["netlify-functions", "withCrumbtrailNetlify"],
  ] as const)("uses the committed Node adapter for %s", (recipe, wrapper) => {
    const text = guidance(recipe);

    expect(text).toContain('from "crumbtrail-node"');
    expect(text).toContain(`${wrapper}(`);
    expect(text).toContain("process.env.CRUMBTRAIL_BASE_URL");
    expect(text).toContain("process.env.CRUMBTRAIL_KEY");
    expect(text).toContain("await Crumbtrail delivery");
    expect(text).toContain(
      "Request and response bodies are excluded by default.",
    );
  });

  it("states the AWS HTTP trigger limitations", () => {
    const text = guidance("aws-lambda");

    expect(text).toContain(
      "Callback handlers and non HTTP triggers are unsupported.",
    );
    expect(text).toContain("APIGatewayProxyEventV2");
  });

  it.each([
    ["vercel-edge-functions", "process.env.CRUMBTRAIL_BASE_URL", "waitUntil"],
    [
      "netlify-edge-functions",
      'Netlify.env.get("CRUMBTRAIL_BASE_URL")',
      "context.waitUntil",
    ],
    ["cloudflare-workers", "env.CRUMBTRAIL_BASE_URL", "ctx.waitUntil"],
    ["deno-deploy", 'Deno.env.get("CRUMBTRAIL_BASE_URL")', "awaits delivery"],
  ] as const)(
    "uses Fetch adapter lifecycle and platform environment access for %s",
    (recipe, endpointAccess, lifecycle) => {
      const text = guidance(recipe);

      expect(text).toContain("withCrumbtrailFetch");
      expect(text).toContain("crumbtrail-core/serverless");
      expect(text).toContain(endpointAccess);
      expect(text).toContain("CRUMBTRAIL_KEY");
      expect(text).toContain(lifecycle);
      expect(text).toContain(
        "Request and response bodies are excluded by default.",
      );
    },
  );

  it("keeps Cloudflare native traces and logs as complementary guidance", () => {
    const text = guidance("cloudflare-workers");
    const value = plan("cloudflare-workers");

    expect(text).toContain("Optional complementary native traces and logs");
    expect(text).toContain(`${ENDPOINT}/v1/traces`);
    expect(text).toContain(`${ENDPOINT}/v1/logs`);
    expect(text).toContain("X-Crumbtrail-Auth");
    expect(value.warnings.join("\n")).toContain("does not export metrics");
  });

  it.each([
    ["vercel-functions-ambiguous", "withCrumbtrailVercel"],
    ["netlify-functions-ambiguous", "withCrumbtrailNetlify"],
  ] as const)(
    "gives %s an exact Node or edge choice",
    (recipe, nodeWrapper) => {
      const text = guidance(recipe);

      expect(text).toContain("Option 1: Node runtime");
      expect(text).toContain("Option 2: edge runtime");
      expect(text).toContain(nodeWrapper);
      expect(text).toContain("withCrumbtrailFetch");
      expect(text).not.toMatch(/installed|wired|verified|complete/i);
    },
  );

  // Goes red if a guided plan starts mutating source, config, dependencies, or env files.
  it.each([
    "aws-lambda",
    "vercel-functions",
    "vercel-edge-functions",
    "vercel-functions-ambiguous",
    "netlify-functions",
    "netlify-edge-functions",
    "netlify-functions-ambiguous",
    "cloudflare-workers",
    "deno-deploy",
  ] as const)(
    "keeps the %s plan nonmutating on repeated execution",
    (recipe) => {
      const value = plan(recipe);
      expect(`${value.snippet}\n${value.agentPrompt}`).not.toMatch(
        /\b(?:installed|wired|verified|complete)\b/i,
      );
      expect(value.snippet).not.toContain("transport:");
      const initial = {
        "/project/package.json": '{"name":"customer"}\n',
        "/project/entry.ts": "export default function handler() {}\n",
        "/project/platform.toml": "[build]\n",
        "/project/.env": "EXISTING=value\n",
      };
      const memory = memExecutorIO(initial);

      const first = executePlan(value, memory.io);
      const second = executePlan(value, memory.io);

      expect(first.written).toEqual([]);
      expect(second.written).toEqual([]);
      expect(first.skipped).toBe(true);
      expect(memory.files).toEqual(initial);
    },
  );
});
