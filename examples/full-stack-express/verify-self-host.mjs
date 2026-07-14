#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runFullStackExpressVerification } from "./verify.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(repoRoot, "packages/node/dist/cli.cjs");
const staticDir = path.join(__dirname);
const timeoutMs = 8_000;

class QuickstartError extends Error {
  constructor(phase, message, context = {}) {
    super(`${phase}: ${message}`);
    this.name = "QuickstartError";
    this.phase = phase;
    this.context = context;
  }
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
    throw new QuickstartError("port", "failed to allocate a local TCP port");
  return address.port;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuickstartError("health", `expected JSON from ${url}`, {
      status: response.status,
      body: text.slice(0, 200),
    });
  }
  return { response, body };
}

async function waitForReadyHealth(url, child, output) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new QuickstartError(
        "server-start",
        "crumbtrail-server exited before readiness",
        {
          exitCode: child.exitCode,
          stdout: boundedTail(output.stdout),
          stderr: boundedTail(output.stderr),
        },
      );
    }

    try {
      const { response, body } = await fetchJson(url);
      if (response.ok && body?.ok === true && body?.status === "ready")
        return body;
      lastError = new Error(
        `health returned status=${response.status} bodyStatus=${body?.status ?? "unknown"}`,
      );
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new QuickstartError(
    "server-start",
    "timed out waiting for ready health",
    {
      lastError: lastError?.message,
      stdout: boundedTail(output.stdout),
      stderr: boundedTail(output.stderr),
    },
  );
}

async function main() {
  await fs.access(cliPath).catch(() => {
    throw new QuickstartError(
      "build",
      "missing built crumbtrail-server CLI; run pnpm --filter crumbtrail-node build first",
      { cliPath },
    );
  });

  const outputDir =
    process.env.CRUMBTRAIL_SELF_HOST_OUTPUT_DIR ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "crumbtrail-self-host-")));
  await fs.mkdir(outputDir, { recursive: true });
  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const healthUrl = `${endpoint}/health`;
  const output = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--output",
      outputDir,
      "--static",
      staticDir,
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout = boundedTail(output.stdout + chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = boundedTail(output.stderr + chunk);
  });

  try {
    const health = await waitForReadyHealth(healthUrl, child, output);
    if (health?.config?.outputDir !== outputDir) {
      throw new QuickstartError(
        "health",
        "health outputDir did not match quickstart output directory",
        {
          expected: outputDir,
          actual: health?.config?.outputDir,
        },
      );
    }

    const result = await runFullStackExpressVerification({
      crumbtrailUrl: endpoint,
      outputDir,
      print: false,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          serverUrl: endpoint,
          healthUrl,
          health: {
            status: health.status,
            outputWritable: health.checks?.outputDir?.writable === true,
            staticConfigured: health.checks?.staticDir?.configured === true,
          },
          sessionId: result.sessionId,
          requestId: result.requestId,
          outputDir: result.outputDir,
          sessionDir: result.sessionDir,
          artifacts: result.artifacts,
          linkedCounts: result.linkedCounts,
          statuses: {
            frontend: result.frontendStatus,
            backend: result.backendStatus,
            mcp: result.mcpStatus,
            mcpCorrelation: result.mcpCorrelationStatus,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main().catch((error) => {
  const payload =
    error instanceof QuickstartError
      ? {
          ok: false,
          phase: error.phase,
          message: error.message,
          context: error.context,
        }
      : {
          ok: false,
          phase: "unknown",
          message: error?.message ?? String(error),
        };
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
});
