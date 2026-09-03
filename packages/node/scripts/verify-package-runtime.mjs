import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const cliPath = path.join(packageRoot, "dist", "cli.cjs");
const distCjsPath = path.join(packageRoot, "dist", "index.cjs");
const distEsmPath = path.join(packageRoot, "dist", "index.js");
const timeoutMs = 8_000;

/**
 * The hosted cloud namespace-imports crumbtrail-node and reads
 * NODE_CONTRACT_CAPABILITIES to decide which contract surfaces the installed
 * package supports. It gates on `=== true` and fails closed on anything else,
 * so a bundler that tree shook or reshaped the marker would silently disable
 * those features with a green build.
 *
 * The map is deliberately EMPTY since the third-party integration surfaces left
 * this package (see src/node-contract-capabilities.ts). This asserts the marker
 * is still exported, still a plain object, and still carries nothing — a key
 * appearing here without the code behind it would switch a cloud feature on.
 */
const EXPECTED_NODE_CONTRACT_CAPABILITIES = {};

function assertCapabilityMarker(format, modulePath, namespace) {
  const marker = namespace?.NODE_CONTRACT_CAPABILITIES;
  if (!marker || typeof marker !== "object") {
    throw new Error(
      `${format} dist (${path.relative(packageRoot, modulePath)}) does not export NODE_CONTRACT_CAPABILITIES`,
    );
  }
  for (const [capability, expected] of Object.entries(
    EXPECTED_NODE_CONTRACT_CAPABILITIES,
  )) {
    if (marker[capability] !== expected) {
      throw new Error(
        `${format} dist NODE_CONTRACT_CAPABILITIES.${capability} is ${JSON.stringify(marker[capability])}, expected ${JSON.stringify(expected)} (the cloud gates on === true)`,
      );
    }
  }
  const unexpected = Object.keys(marker).filter(
    (key) => !(key in EXPECTED_NODE_CONTRACT_CAPABILITIES),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${format} dist NODE_CONTRACT_CAPABILITIES has unexpected keys: ${unexpected.join(", ")}`,
    );
  }
  return marker;
}

async function assertBuiltCapabilityMarker() {
  await fs.access(distCjsPath);
  await fs.access(distEsmPath);

  const cjsNamespace = createRequire(import.meta.url)(distCjsPath);
  const esmNamespace = await import(pathToFileURL(distEsmPath).href);
  const cjs = assertCapabilityMarker(
    "CJS",
    distCjsPath,
    cjsNamespace,
  );
  const esm = assertCapabilityMarker(
    "ESM",
    distEsmPath,
    esmNamespace,
  );
  for (const [format, namespace] of [
    ["CJS", cjsNamespace],
    ["ESM", esmNamespace],
  ]) {
    for (const name of ["instrumentPrismaClient", "instrumentMongoClient"]) {
      if (typeof namespace[name] !== "function") {
        throw new Error(`${format} dist does not export ${name} from package root`);
      }
    }
  }

  console.log(
    `CRUMBTRAIL_NODE_CONTRACT_MARKER_PASS cjs=${JSON.stringify(cjs)} esm=${JSON.stringify(esm)}`,
  );
}

function boundedTail(value, max = 1_200) {
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function onceServerListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function getFreePort() {
  const server = net.createServer();
  await onceServerListening(server);
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (!address || typeof address === "string")
    throw new Error("Failed to allocate a local TCP port");
  return address.port;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${url}, got ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return { response, body };
}

async function waitForHealth(url, child, output, headers = {}) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited before readiness with code ${child.exitCode}`,
      );
    }

    try {
      const { response, body } = await fetchJson(url, headers);
      if (response.ok && body?.ok === true && body?.status === "ready")
        return body;
      lastError = new Error(
        `health returned ${response.status} status=${body?.status ?? "unknown"}`,
      );
    } catch (err) {
      lastError = err;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `timed out waiting for readiness: ${lastError?.message ?? "no response"}\nstdout=${boundedTail(output.stdout)}\nstderr=${boundedTail(output.stderr)}`,
  );
}

function assertHealthyPayload(body, outputDir, staticDir) {
  if (body?.service !== "crumbtrail-node")
    throw new Error("health payload missing service");
  if (body?.config?.outputDir !== outputDir)
    throw new Error("health payload outputDir mismatch");
  if (body?.config?.staticDir !== staticDir)
    throw new Error("health payload staticDir mismatch");
  if (body?.config?.authEnabled !== true)
    throw new Error("health payload did not report auth enabled");
  if (body?.config?.allowedOriginCount !== 1)
    throw new Error("health payload did not report allowed-origin count");
  if (body?.checks?.outputDir?.writable !== true)
    throw new Error("health payload did not report writable outputDir");
  if (
    JSON.stringify(body).includes("verifier-secret-token") ||
    JSON.stringify(body).includes("app.example.com")
  ) {
    throw new Error("health payload leaked sensitive config values");
  }
}

async function assertDegradedOutputDir(healthUrl, outputDir, headers = {}) {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.writeFile(outputDir, "not a directory");
  const { response, body } = await fetchJson(healthUrl, headers);
  if (!response.ok)
    throw new Error(`degraded health request failed with ${response.status}`);
  if (body?.ok !== false || body?.status !== "degraded")
    throw new Error(`expected degraded health, got ${JSON.stringify(body)}`);
  if (
    body?.checks?.outputDir?.path !== outputDir ||
    body?.checks?.outputDir?.writable !== false
  ) {
    throw new Error("degraded health payload did not report outputDir failure");
  }
}

/**
 * A built file that nothing references is a file nothing runs, and `dist/cli.js`
 * shipped broken for exactly that reason: esbuild's ESM output answers the
 * bundled `require("fs")` with `Dynamic require of "fs" is not supported`, and
 * since `bin` pointed at the CJS twin, no suite and no consumer ever loaded it.
 * The executable now has one form, and this asserts both halves of that: the
 * advertised bin starts, and no second build of it is lying around beside it.
 */
async function assertSingleExecutableEntry() {
  const distDir = path.join(packageRoot, "dist");
  const strays = (await fs.readdir(distDir)).filter(
    (name) => /^cli\..*js$/.test(name) && name !== path.basename(cliPath),
  );
  if (strays.length > 0) {
    throw new Error(
      `dist ships ${strays.join(", ")} beside the ${path.basename(cliPath)} that bin points at; an unreferenced build of the CLI is never loaded, so it is never known to be broken`,
    );
  }

  const help = spawn(process.execPath, [cliPath, "--help"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  let stderr = "";
  help.stdout.setEncoding("utf8");
  help.stderr.setEncoding("utf8");
  help.stdout.on("data", (chunk) => (stdout += chunk));
  help.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => help.once("exit", resolve));
  if (code !== 0 || !stdout.includes("Usage:")) {
    throw new Error(
      `${path.basename(cliPath)} --help exited ${code} without printing usage\nstdout=${boundedTail(stdout)}\nstderr=${boundedTail(stderr)}`,
    );
  }
}

async function main() {
  await fs.access(cliPath);
  await assertSingleExecutableEntry();
  await assertBuiltCapabilityMarker();

  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "crumbtrail-package-runtime-"),
  );
  const staticDir = path.join(tmpRoot, "static");
  const outputDir = path.join(tmpRoot, "sessions");
  await fs.mkdir(staticDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(staticDir, "index.html"),
    "<!doctype html><title>Crumbtrail package smoke</title><h1>package runtime ok</h1>",
  );

  const port = await getFreePort();
  const output = { stdout: "", stderr: "" };
  const args = [
    cliPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--output",
    outputDir,
    "--static",
    staticDir,
    "--allow-origin",
    "https://app.example.com",
    "--auth-token",
    "verifier-secret-token",
  ];
  const child = spawn(process.execPath, args, {
    cwd: tmpRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout = boundedTail(output.stdout + chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = boundedTail(output.stderr + chunk);
  });

  try {
    const healthUrl = `http://127.0.0.1:${port}/health`;
    const rootUrl = `http://127.0.0.1:${port}/`;
    const authHeaders = { "X-Crumbtrail-Auth": "verifier-secret-token" };
    const healthBody = await waitForHealth(
      healthUrl,
      child,
      output,
      authHeaders,
    );
    assertHealthyPayload(healthBody, outputDir, staticDir);

    const rootResponse = await fetch(rootUrl);
    const rootBody = await rootResponse.text();
    if (!rootResponse.ok || !rootBody.includes("package runtime ok")) {
      throw new Error(`static probe failed with ${rootResponse.status}`);
    }
    if (!output.stdout.includes("Allowed browser origins: 1 configured")) {
      throw new Error(
        "startup diagnostics did not report allowed-origin count",
      );
    }
    if (
      !output.stdout.includes("Auth token protection enabled for /api/* routes")
    ) {
      throw new Error(
        "startup diagnostics did not report auth-token protection",
      );
    }
    if (
      output.stdout.includes("verifier-secret-token") ||
      output.stderr.includes("verifier-secret-token")
    ) {
      throw new Error("startup diagnostics leaked auth token content");
    }
    await assertDegradedOutputDir(healthUrl, outputDir, authHeaders);

    console.log(
      `CRUMBTRAIL_PACKAGE_RUNTIME_PASS cli=${path.relative(packageRoot, cliPath)} port=${port} health=${healthUrl} output=${outputDir}`,
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(
    `CRUMBTRAIL_PACKAGE_RUNTIME_FAIL phase=startup message=${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
