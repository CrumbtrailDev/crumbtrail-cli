#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../packages/node/dist/index.js";
import { runInvoiceDigestJob } from "./worker.mjs";

const __filename = fileURLToPath(import.meta.url);
const REQUIRED_ARTIFACTS = [
  "events.ndjson",
  "index.json",
  "llm.json",
  "llm.md",
];

class VerificationError extends Error {
  constructor(phase, message, context = {}) {
    super(`${phase}: ${message}`);
    this.name = "VerificationError";
    this.phase = phase;
    this.context = context;
  }
}

export async function runHeadlessJobVerification(options = {}) {
  const shouldCleanup =
    options.cleanup ??
    (options.outputDir === undefined &&
      process.env.CRUMBTRAIL_EXAMPLE_OUTPUT_DIR === undefined);
  const outputDir =
    options.outputDir ??
    process.env.CRUMBTRAIL_EXAMPLE_OUTPUT_DIR ??
    fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-headless-job-"));
  const server = createServer({ port: 0, outputDir });
  const sessionId = options.sessionId ?? `headless-job-${Date.now()}`;

  try {
    await listen(server, "127.0.0.1");
    const endpoint = serverUrl(server);
    const result = await runInvoiceDigestJob({
      endpoint,
      sessionId,
      metadata: {
        app: "billing-worker",
        release: "R182",
        build: "headless-example",
      },
      now: monotonicClock(1_800_000_000_000),
    });

    const sessionDir = findSessionDir(outputDir, sessionId);
    if (!sessionDir) {
      throw new VerificationError(
        "artifacts",
        "finalized headless session directory was not found",
        { outputDir, sessionId },
      );
    }
    for (const artifact of REQUIRED_ARTIFACTS) {
      const artifactPath = path.join(sessionDir, artifact);
      if (!fs.existsSync(artifactPath)) {
        throw new VerificationError("artifacts", `missing ${artifact}`, {
          sessionDir,
        });
      }
    }

    const meta = readJson(path.join(sessionDir, "meta.json"));
    if (
      meta.source !== "headless" ||
      meta.app !== "billing-worker" ||
      meta.release !== "R182"
    ) {
      throw new VerificationError(
        "metadata",
        "headless metadata was not persisted",
        { meta },
      );
    }

    const events = readNdjson(path.join(sessionDir, "events.ndjson"));
    const kinds = countKinds(events);
    if (kinds.con < 2)
      throw new VerificationError(
        "events",
        "job log events were not captured",
        { kinds },
      );
    if (kinds["backend.otel.span"] !== 1)
      throw new VerificationError("events", "backend span was not captured", {
        kinds,
      });
    if (kinds["backend.otel.log"] !== 1)
      throw new VerificationError("events", "backend log was not captured", {
        kinds,
      });
    if (kinds["db.diff"] !== 1)
      throw new VerificationError("events", "db.diff was not captured", {
        kinds,
      });

    const serializedEvents = JSON.stringify(events);
    if (serializedEvents.includes("sk_fake_should_be_redacted")) {
      throw new VerificationError(
        "redaction",
        "sensitive DB value rested in captured events",
      );
    }

    const bundle = readJson(path.join(sessionDir, "llm.json"));
    if (bundle.session?.source !== "headless") {
      throw new VerificationError(
        "bundle",
        "llm bundle did not preserve headless source",
        { session: bundle.session },
      );
    }
    if (
      !Array.isArray(bundle.databaseDiffs) ||
      bundle.databaseDiffs.length !== 1
    ) {
      throw new VerificationError(
        "bundle",
        "llm bundle did not surface the db diff",
        { databaseDiffs: bundle.databaseDiffs },
      );
    }

    return {
      ok: true,
      outputDir,
      sessionId,
      sessionDir,
      kinds,
      finalization: result.finalization,
    };
  } finally {
    await closeServer(server);
    if (shouldCleanup) fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function monotonicClock(start) {
  let t = start;
  return () => {
    t += 25;
    return t;
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readNdjson(filePath) {
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content ? content.split("\n").map((line) => JSON.parse(line)) : [];
}

function countKinds(events) {
  return events.reduce((acc, event) => {
    acc[event.k] = (acc[event.k] ?? 0) + 1;
    return acc;
  }, {});
}

function findSessionDir(outputDir, sessionId) {
  const stack = [outputDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "meta.json")) {
      const meta = readJson(path.join(current, "meta.json"));
      if (meta.id === sessionId || meta.sessionId === sessionId) return current;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        stack.push(path.join(current, entry.name));
    }
  }
  return undefined;
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new VerificationError(
      "server",
      "server did not expose a TCP address",
    );
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

if (process.argv[1] === __filename) {
  runHeadlessJobVerification()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
