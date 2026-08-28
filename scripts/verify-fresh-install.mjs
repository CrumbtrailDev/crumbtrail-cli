#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions } from "./verify-sdk-version-floors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const coreRoot = path.join(repoRoot, "packages", "core");
const nodeRoot = path.join(repoRoot, "packages", "node");
const cliRoot = path.join(repoRoot, "packages", "cli");
const timeoutMs = 10_000;
const maxDiagnosticChars = 1_500;
const authToken = "fresh-install-verifier-auth-token";
const allowedOrigin = "https://fresh-install.example.test";

const phases = [];

function boundedTail(value, max = maxDiagnosticChars) {
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function redact(value) {
  return String(value)
    .replaceAll(authToken, "[REDACTED_AUTH_TOKEN]")
    .replaceAll(allowedOrigin, "[REDACTED_ALLOWED_ORIGIN]");
}

function phaseLog(phase, status, detail = "") {
  const suffix = detail ? ` ${redact(detail)}` : "";
  console.log(
    `CRUMBTRAIL_FRESH_INSTALL_${status.toUpperCase()} phase=${phase}${suffix}`,
  );
}

function recordPhase(phase, status, detail = "") {
  phases.push({ phase, status, detail: redact(detail) });
  phaseLog(phase, status, detail);
}

function fail(phase, err, context = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const details = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `${key}=${JSON.stringify(redact(boundedTail(String(value))))}`,
    )
    .join(" ");
  console.error(
    `CRUMBTRAIL_FRESH_INSTALL_FAIL phase=${phase} message=${JSON.stringify(redact(message))}${details ? ` ${details}` : ""}`,
  );
  if (phases.length > 0) {
    console.error(`CRUMBTRAIL_FRESH_INSTALL_PHASES ${JSON.stringify(phases)}`);
  }
  process.exit(1);
}

async function runCommand(phase, command, args, options = {}) {
  recordPhase(phase, "start", `command=${command} ${args.join(" ")}`);
  const output = { stdout: "", stderr: "" };
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout = boundedTail(output.stdout + chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = boundedTail(output.stderr + chunk);
  });

  const exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
  if (exitCode !== 0) {
    fail(phase, new Error(`command exited with ${exitCode}`), output);
  }
  recordPhase(phase, "pass");
  return output;
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

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function assertPackageMetadata() {
  recordPhase("package-metadata", "start");
  const [corePkg, nodePkg] = await Promise.all([
    readJsonFile(path.join(coreRoot, "package.json")),
    readJsonFile(path.join(nodeRoot, "package.json")),
  ]);

  if (corePkg.name !== "crumbtrail-core")
    throw new Error("packages/core package name mismatch");
  if (!corePkg.files?.includes("dist"))
    throw new Error("crumbtrail-core package files must include dist");
  if (nodePkg.name !== "crumbtrail-node")
    throw new Error("packages/node package name mismatch");
  if (nodePkg.bin)
    throw new Error("crumbtrail-node must ship no executable");
  if (!nodePkg.files?.includes("dist"))
    throw new Error("crumbtrail-node package files must include dist");
  // core is ALSO inlined into node's build (tsup noExternal), so node's runtime never imports this
  // declared dep — it exists so `npm i crumbtrail-node` pulls core in for the browser SDK. See
  // packages/node/tsup.config.ts for the full dual-topology rationale before changing this.
  if (nodePkg.dependencies?.["crumbtrail-core"] !== "workspace:^") {
    throw new Error(
      "crumbtrail-node must declare crumbtrail-core as a workspace runtime dependency",
    );
  }
  recordPhase(
    "package-metadata",
    "pass",
    `core=${corePkg.version} node=${nodePkg.version}`,
  );
}

async function packPackage(packageDir, packDir) {
  const before = new Set(await fs.readdir(packDir));
  await runCommand(
    "package-pack",
    "pnpm",
    ["pack", "--pack-destination", packDir],
    { cwd: packageDir },
  );
  const after = await fs.readdir(packDir);
  const created = after.filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  if (created.length !== 1)
    throw new Error(
      `expected one tarball from ${packageDir}, found ${created.length}`,
    );
  return path.join(packDir, created[0]);
}

async function readPackedPackageJson(tarballPath, extractDir) {
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  await runCommand("packed-manifest-extract", "tar", [
    "-xzf",
    tarballPath,
    "-C",
    extractDir,
    "package/package.json",
  ]);
  return readJsonFile(path.join(extractDir, "package", "package.json"));
}

async function assertPackedNodeDependency(
  nodeTarball,
  extractDir,
  expectedCoreRange,
) {
  recordPhase("packed-manifest", "start");
  const packedPkg = await readPackedPackageJson(nodeTarball, extractDir);
  if (packedPkg.dependencies?.["crumbtrail-core"] !== expectedCoreRange) {
    throw new Error(
      `packed crumbtrail-node must rewrite crumbtrail-core workspace dependency to ${expectedCoreRange}, got ${packedPkg.dependencies?.["crumbtrail-core"] ?? "missing"}`,
    );
  }
  if (packedPkg.bin)
    throw new Error("packed crumbtrail-node must ship no executable");
  if (!packedPkg.files?.includes("dist"))
    throw new Error("packed crumbtrail-node package files must include dist");
  recordPhase("packed-manifest", "pass", `crumbtrail-core=${expectedCoreRange}`);
}

async function assertPackedCliInstallSpecs(cliTarball, tempProjectDir, expectedSpecs) {
  recordPhase("packed-cli-install-specs", "start");
  await fs.writeFile(
    path.join(tempProjectDir, "package.json"),
    JSON.stringify({ private: true, type: "commonjs" }, null, 2),
  );
  await runCommand(
    "packed-cli-install",
    "npm",
    ["i", `crumbtrail@file:${cliTarball}`, "--ignore-scripts"],
    { cwd: tempProjectDir },
  );
  const probe = await runCommand(
    "packed-cli-probe",
    process.execPath,
    [
      "-e",
      'const { sdkInstallSpec } = require("crumbtrail"); console.log(JSON.stringify([sdkInstallSpec("crumbtrail-core"), sdkInstallSpec("crumbtrail-node")]));',
    ],
    { cwd: tempProjectDir },
  );
  const emittedSpecs = JSON.parse(probe.stdout.trim());
  // Assert the SHAPE and the floor relationship, not an exact string. Pinning
  // the expected floor to the current workspace version is what made this check
  // go stale on every release; a floor is allowed to lag behind latest.
  if (emittedSpecs.length !== expectedSpecs.length) {
    throw new Error(`packed crumbtrail emitted ${emittedSpecs.length} install specs, expected ${expectedSpecs.length}`);
  }
  for (const [index, { pkg, maxVersion }] of expectedSpecs.entries()) {
    const emitted = emittedSpecs[index];
    const match = new RegExp(`^${pkg}@>=(\\d+\\.\\d+\\.\\d+)$`).exec(emitted ?? "");
    if (!match) {
      throw new Error(`packed crumbtrail emitted install spec ${JSON.stringify(emitted)}, expected ${pkg}@>=<floor>`);
    }
    if (compareVersions(match[1], maxVersion) > 0) {
      throw new Error(`packed crumbtrail floor ${emitted} is ahead of the workspace version ${maxVersion}`);
    }
  }
  recordPhase("packed-cli-install-specs", "pass", `specs=${emittedSpecs.join(",")}`);
}

async function installTempProject(tempProjectDir, coreTarball, nodeTarball) {
  recordPhase("temp-install", "start", `project=${tempProjectDir}`);
  // Install both packed tarballs with no pnpm.overrides. This proves the local prepublish flow
  // matches npm consumer semantics: crumbtrail-node keeps a real runtime dependency on core, and
  // the packed node manifest rewrites the workspace protocol to a public semver range.
  await fs.writeFile(
    path.join(tempProjectDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  await runCommand(
    "temp-install",
    "npm",
    [
      "i",
      `crumbtrail-core@file:${coreTarball}`,
      `crumbtrail-node@file:${nodeTarball}`,
      "--ignore-scripts",
    ],
    { cwd: tempProjectDir },
  );
  recordPhase("temp-install", "pass");
}

async function assertInstalledPackageMetadata(
  tempProjectDir,
  expectedCoreVersion,
) {
  recordPhase("installed-package-metadata", "start");
  const installedPkg = await readJsonFile(
    path.join(
      tempProjectDir,
      "node_modules",
      "crumbtrail-node",
      "package.json",
    ),
  );
  const expectedCoreRange = `^${expectedCoreVersion}`;
  if (installedPkg.dependencies?.["crumbtrail-core"] !== expectedCoreRange) {
    throw new Error(
      `installed crumbtrail-node must declare crumbtrail-core dependency as ${expectedCoreRange}`,
    );
  }
  const installedCorePkg = await readJsonFile(
    path.join(
      tempProjectDir,
      "node_modules",
      "crumbtrail-core",
      "package.json",
    ),
  );
  if (
    installedCorePkg.name !== "crumbtrail-core" ||
    installedCorePkg.version !== expectedCoreVersion
  ) {
    throw new Error("installed crumbtrail-core package metadata mismatch");
  }
  recordPhase("installed-package-metadata", "pass");
}

/**
 * The runtime proof, now that there is no binary to start: install the packed
 * tarballs, point `autoCapture` at a stub intake in the same process, throw,
 * and require the event to arrive. This is what a customer's process actually
 * does with this package.
 */
async function assertInstalledCapture(tempProjectDir) {
  const probe = path.join(tempProjectDir, "capture-probe.mjs");
  await fs.writeFile(
    probe,
    `import http from "node:http";
import { autoCapture } from "crumbtrail-node";

const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    received.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessionId: "fresh-install-probe" }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = "http://127.0.0.1:" + server.address().port;

const handle = await autoCapture({
  endpoint,
  authToken: "verify-fresh-install",
  service: "fresh-install-probe",
  loadEnv: false,
});

console.error("fresh install probe failure");
await new Promise((resolve) => setTimeout(resolve, 1000));
handle.stop();
server.close();

if (received.length === 0) {
  console.log("CAPTURE_PROBE_FAIL nothing reached the stub intake");
  process.exit(1);
}
console.log("CAPTURE_PROBE_OK requests=" + received.length);
`,
  );
  const output = await runCommand("capture-proof", process.execPath, [probe], {
    cwd: tempProjectDir,
  });
  const combined = `${output.stdout}${output.stderr}`;
  if (!combined.includes("CAPTURE_PROBE_OK")) {
    throw new Error(
      `capture probe did not confirm delivery: ${boundedTail(combined)}`,
    );
  }
}

async function main() {
  let tmpRoot;
  let child;
  try {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "crumbtrail-fresh-install-"),
    );
    const packDir = path.join(tmpRoot, "packed");
    const tempProjectDir = path.join(tmpRoot, "project");
    const cliProjectDir = path.join(tmpRoot, "packed-cli-project");
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(tempProjectDir, { recursive: true });
    await fs.mkdir(cliProjectDir, { recursive: true });

    await assertPackageMetadata();
    const corePackage = await readJsonFile(path.join(coreRoot, "package.json"));
    const expectedCoreVersion = corePackage.version;
    // core must be built first so node's build can bundle it in.
    await runCommand("package-build", "pnpm", [
      "--filter",
      "crumbtrail-core",
      "build",
    ]);
    await runCommand("package-build", "pnpm", [
      "--filter",
      "crumbtrail-node",
      "build",
    ]);
    await runCommand("package-build", "pnpm", [
      "--filter",
      "crumbtrail",
      "build",
    ]);

    const coreTarball = await packPackage(coreRoot, packDir);
    const nodeTarball = await packPackage(nodeRoot, packDir);
    const cliTarball = await packPackage(cliRoot, packDir);
    await assertPackedNodeDependency(
      nodeTarball,
      path.join(tmpRoot, "packed-node-manifest"),
      `^${expectedCoreVersion}`,
    );
    const nodePackage = await readJsonFile(path.join(nodeRoot, "package.json"));
    await assertPackedCliInstallSpecs(cliTarball, cliProjectDir, [
      { pkg: "crumbtrail-core", maxVersion: expectedCoreVersion },
      { pkg: "crumbtrail-node", maxVersion: nodePackage.version },
    ]);
    await installTempProject(tempProjectDir, coreTarball, nodeTarball);
    await assertInstalledPackageMetadata(tempProjectDir, expectedCoreVersion);

    await assertInstalledCapture(tempProjectDir);

    recordPhase("complete", "pass", `project=${tempProjectDir}`);
    console.log(
      "CRUMBTRAIL_FRESH_INSTALL_PASS phases=package-metadata,package-build,package-pack,packed-cli-install-specs,temp-install,installed-package-metadata,capture-proof",
    );
  } catch (err) {
    fail("unexpected", err);
  } finally {
    if (tmpRoot)
      await fs
        .rm(tmpRoot, { recursive: true, force: true })
        .catch(() => undefined);
  }
}

main();
