import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  compileDataWitness,
  validateDataWitness,
  type DataWitness,
  type DbWitnessEventData,
} from "crumbtrail-core";
import { buildDbWitnessEvent } from "crumbtrail-node";
import { executeWitness, WitnessConnectionError } from "./execute";
import { witnessCopy as t } from "./copy";
import { loadAuth } from "../auth";

export interface WitnessCommandIO {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(text: string): void;
  wait(): Promise<void>;
  repair(script: string): Promise<boolean>;
}
const defaultIO = (): WitnessCommandIO => ({
  env: process.env,
  fetch,
  out: (text) => process.stdout.write(`${text}\n`),
  async wait() {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await rl.question(t("WITNESS_WAIT"));
    } finally {
      rl.close();
    }
  },
  repair: (script) =>
    new Promise((resolve) => {
      const child = spawn(script, [], { stdio: "ignore", shell: false });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    }),
});
export async function runWitnessCommand(
  args: string[],
  io: WitnessCommandIO = defaultIO(),
): Promise<number> {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (["--dry-run", "--wait", "--help"].includes(args[i])) flags.add(args[i]);
    else if (
      [
        "--project",
        "--issue",
        "--fix-script",
        "--connection-env",
        "--endpoint",
      ].includes(args[i]) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      options.set(args[i], args[++i]);
    else {
      io.out(t("WITNESS_USAGE"));
      return 1;
    }
  }
  if (flags.has("--help")) {
    io.out(t("WITNESS_USAGE"));
    return 0;
  }
  const saved = loadAuth(io.env);
  const endpoint =
    options.get("--endpoint") ?? io.env.CRUMBTRAIL_ENDPOINT ?? saved?.endpoint;
  const token =
    io.env.CRUMBTRAIL_AGENT_TOKEN ??
    (saved && saved.endpoint === endpoint ? saved.token : undefined);
  const project = options.get("--project");
  const issue = options.get("--issue");
  if (!endpoint || !token || !project || !issue) {
    io.out(t("WITNESS_CONFIG_REQUIRED"));
    return 1;
  }
  let base: URL;
  try {
    base = new URL(endpoint);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error();
  } catch {
    io.out(t("WITNESS_CONFIG_REQUIRED"));
    return 1;
  }
  const request = async (
    path: string,
    body?: unknown,
    credential = token,
  ): Promise<Record<string, any>> => {
    const response = await io.fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(credential === token
          ? { Authorization: `Bearer ${credential}` }
          : { "X-Crumbtrail-Auth": credential ?? "" }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("WITNESS_REQUEST_FAILED");
    return response.json();
  };
  try {
    const view = await request(
      `/api/agent/repro-validation?project=${encodeURIComponent(project)}&issue=${encodeURIComponent(issue)}&include=witness`,
    );
    if (view.witness?.status !== "proposed") {
      io.out(t("WITNESS_REFUSED"));
      return 1;
    }
    const witness: DataWitness = view.witness.witness;
    validateDataWitness(witness);
    if (flags.has("--dry-run")) {
      for (const statement of compileDataWitness(witness))
        io.out(
          t("WITNESS_DRY_RUN", {
            engine: witness.engine,
            shape: statement.shape,
            parameters: JSON.stringify(statement.parameters),
            columns: statement.identifyingColumns.join(", "),
          }),
        );
      return 0;
    }
    const script = options.has("--fix-script")
      ? resolve(options.get("--fix-script")!)
      : undefined;
    let scriptContent: Buffer;
    try {
      if (!script) throw new Error();
      scriptContent = await readFile(script);
    } catch {
      io.out(t("WITNESS_FIX_REQUIRED"));
      return 1;
    }
    const connectionEnv = options.get("--connection-env") ?? "DATABASE_URL";
    const connectionString = io.env[connectionEnv];
    if (!connectionString || !io.env.CRUMBTRAIL_PROJECT_KEY) {
      io.out(
        t("WITNESS_CONNECTION_REQUIRED", {
          name: !connectionString ? connectionEnv : "CRUMBTRAIL_PROJECT_KEY",
        }),
      );
      return 1;
    }
    const started = await request("/api/agent/repro-validation", {
      project,
      issue,
      producer: "witness",
    });
    const runId = started.runId;
    const service = started.reproCase?.serviceScope;
    if (
      typeof runId !== "string" ||
      typeof service !== "string" ||
      started.witness?.witness?.id !== witness.id
    )
      throw new Error("WITNESS_REQUEST_FAILED");
    const upload = async (phase: "before" | "after", fingerprint: string) => {
      const statements = await executeWitness(witness, connectionString);
      const observation: DbWitnessEventData = {
        witnessId: witness.id,
        engine: witness.engine,
        runId,
        phase,
        identity: { kind: "migration", fingerprint },
        statements,
      };
      const event = buildDbWitnessEvent(witness, observation);
      const safeStatements = event.d
        .statements as DbWitnessEventData["statements"];
      io.out(
        t("WITNESS_COUNTS", {
          phase: t(phase === "before" ? "WITNESS_BEFORE" : "WITNESS_AFTER"),
          counts: statements.map((s) => String(s.rowCount)).join(", "),
          keys: JSON.stringify(safeStatements.map((s) => s.identifyingRows)),
        }),
      );
      const sessionId = `witness_${randomUUID().replaceAll("-", "")}`;
      await request(
        "/api/session/start",
        { sessionId, metadata: { service, migration: fingerprint } },
        io.env.CRUMBTRAIL_PROJECT_KEY,
      );
      await request(
        "/api/events",
        { sessionId, events: [{ ...event, sessionId }] },
        io.env.CRUMBTRAIL_PROJECT_KEY,
      );
      await request(
        "/api/session/end",
        { sessionId },
        io.env.CRUMBTRAIL_PROJECT_KEY,
      );
      return { sessionId, statements };
    };
    const before = await upload(
      "before",
      createHash("sha256").update(`before:${witness.id}`).digest("hex"),
    );
    if (before.statements.every((s) => s.rowCount > 0)) {
      if (flags.has("--wait")) await io.wait();
      else if (!(await io.repair(script!))) {
        io.out(t("WITNESS_FIX_FAILED"));
        return 1;
      }
    } else io.out(t("WITNESS_NON_REPRODUCIBLE"));
    const after = await upload(
      "after",
      createHash("sha256").update(scriptContent).digest("hex"),
    );
    const settled = await request("/api/agent/repro-validation", {
      project,
      issue,
      sessions: { control: before.sessionId, candidate: after.sessionId },
    });
    const verdict = settled.verdict;
    if (typeof verdict !== "string") {
      io.out(t("WITNESS_SESSION_PENDING"));
      return 1;
    }
    io.out(t("WITNESS_VERDICT", { verdict }));
    if (typeof settled.remedy === "string") io.out(settled.remedy);
    return verdict === "verified_fix" || verdict === "non_reproducible" ? 0 : 1;
  } catch (error) {
    if (error instanceof WitnessConnectionError)
      io.out(t("WITNESS_CONNECTION_FAILED", { target: error.target }));
    else
      io.out(
        t(
          error instanceof Error && error.message === "WITNESS_REQUEST_FAILED"
            ? "WITNESS_REQUEST_FAILED"
            : "WITNESS_INVALID",
        ),
      );
    return 1;
  }
}
