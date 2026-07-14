import fs from "node:fs";
import path from "node:path";
import type { EvidenceCandidate } from "./evidence-index";

export interface AiDiagnosisConfig {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  allowAutoModel?: boolean;
  maxWindows?: number;
  maxPromptBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Diagnose finalized sessions already on disk when the server starts. */
  backfillOnStart?: boolean;
  /** Bounded provider concurrency for startup backfill. Default 2. */
  backfillConcurrency?: number;
}

export interface AiDiagnosisResult {
  ok: boolean;
  skipped?:
    | "opt_in_disabled"
    | "missing_key"
    | "no_candidates"
    | "already_exists"
    | "in_progress";
  error?: string;
}

export interface AiDiagnosisBackfillResult {
  checked: number;
  generated: number;
  skipped: number;
  failed: number;
}

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_MAX_WINDOWS = 40;
const DEFAULT_MAX_PROMPT_BYTES = 180_000;
const inFlightDiagnosisDirs = new Set<string>();
const queuedDiagnosisDirs = new Set<string>();

interface DiagnosisQueueItem {
  sessionDir: string;
  key: string;
  resolve: (result: AiDiagnosisResult) => void;
}

interface DiagnosisQueue {
  active: number;
  pending: DiagnosisQueueItem[];
  pumpScheduled: boolean;
}

const diagnosisQueues = new WeakMap<AiDiagnosisConfig, DiagnosisQueue>();

export async function runAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisResult> {
  if (!config.enabled) return { ok: true, skipped: "opt_in_disabled" };
  if (hasDiagnosisArtifacts(sessionDir))
    return { ok: true, skipped: "already_exists" };
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: true, skipped: "missing_key" };

  try {
    const candidates = readCandidates(sessionDir);
    if (candidates.length === 0) return { ok: true, skipped: "no_candidates" };

    const model = selectModel(config.model, config.allowAutoModel === true);
    const fetchImpl = config.fetchImpl ?? fetch;
    const prompt = buildPrompt(
      sessionDir,
      candidates,
      config.maxWindows ?? DEFAULT_MAX_WINDOWS,
      config.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
    );

    config.log?.(
      `Crumbtrail AI diagnosis enabled; sending AI-safe candidate metadata to OpenRouter model ${model}.`,
    );
    const res = await fetchImpl(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are ranking Crumbtrail deterministic issue candidates. Return strict JSON only.",
            },
            { role: "user", content: prompt },
          ],
        }),
      },
    );

    if (!res.ok)
      return {
        ok: false,
        error: `OpenRouter request failed with HTTP ${res.status}`,
      };
    const payload: unknown = await res.json();
    const content = extractContent(payload);
    if (!content)
      return {
        ok: false,
        error: "OpenRouter response did not include content",
      };
    const diagnosis = JSON.parse(content) as Record<string, unknown>;
    writeSessionFileNoSymlink(
      sessionDir,
      "diagnosis.json",
      `${JSON.stringify(diagnosis, null, 2)}\n`,
    );
    writeSessionFileNoSymlink(
      sessionDir,
      "diagnosis.md",
      renderDiagnosisMarkdown(diagnosis),
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI diagnosis failed",
    };
  }
}

export function scheduleAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): void {
  if (!config.enabled) return;
  void enqueueAiDiagnosis(sessionDir, config).then((result) => {
    if (!result.ok)
      config.log?.(
        `Crumbtrail AI diagnosis failed: ${result.error ?? "unknown error"}`,
      );
  });
}

/** Diagnose a pre-existing finalized-session backlog without an unbounded
 * provider fan-out. Existing artifacts and sessions without candidates are
 * cheap skips handled by runAiDiagnosis. */
export async function backfillAiDiagnoses(
  sessionDirs: readonly string[],
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisBackfillResult> {
  const uniqueDirs = [...new Set(sessionDirs.map((dir) => path.resolve(dir)))];
  const result: AiDiagnosisBackfillResult = {
    checked: uniqueDirs.length,
    generated: 0,
    skipped: 0,
    failed: 0,
  };
  const concurrency = Math.max(
    1,
    Math.min(8, config.backfillConcurrency ?? 2, uniqueDirs.length || 1),
  );
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= uniqueDirs.length) return;
      const diagnosis = await enqueueAiDiagnosis(uniqueDirs[index]!, config);
      if (!diagnosis.ok) result.failed += 1;
      else if (diagnosis.skipped) result.skipped += 1;
      else result.generated += 1;
    }
  });
  await Promise.all(workers);
  return result;
}

function enqueueAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisResult> {
  const key = path.resolve(sessionDir);
  if (hasDiagnosisArtifacts(sessionDir))
    return Promise.resolve({ ok: true, skipped: "already_exists" });
  if (inFlightDiagnosisDirs.has(key) || queuedDiagnosisDirs.has(key)) {
    return Promise.resolve({ ok: true, skipped: "in_progress" });
  }

  let queue = diagnosisQueues.get(config);
  if (!queue) {
    queue = { active: 0, pending: [], pumpScheduled: false };
    diagnosisQueues.set(config, queue);
  }
  queuedDiagnosisDirs.add(key);
  const result = new Promise<AiDiagnosisResult>((resolve) => {
    queue!.pending.push({ sessionDir, key, resolve });
  });
  scheduleDiagnosisQueuePump(queue, config);
  return result;
}

function scheduleDiagnosisQueuePump(
  queue: DiagnosisQueue,
  config: AiDiagnosisConfig,
): void {
  if (queue.pumpScheduled) return;
  queue.pumpScheduled = true;
  setTimeout(() => {
    queue.pumpScheduled = false;
    pumpDiagnosisQueue(queue, config);
  }, 0);
}

function pumpDiagnosisQueue(
  queue: DiagnosisQueue,
  config: AiDiagnosisConfig,
): void {
  const limit = Math.max(1, Math.min(8, config.backfillConcurrency ?? 2));
  while (queue.active < limit && queue.pending.length > 0) {
    const item = queue.pending.shift()!;
    queuedDiagnosisDirs.delete(item.key);
    inFlightDiagnosisDirs.add(item.key);
    queue.active += 1;
    void runAiDiagnosis(item.sessionDir, config)
      .then(item.resolve)
      .finally(() => {
        inFlightDiagnosisDirs.delete(item.key);
        queue.active -= 1;
        pumpDiagnosisQueue(queue, config);
      });
  }
}

function hasDiagnosisArtifacts(sessionDir: string): boolean {
  return (
    fs.existsSync(path.join(sessionDir, "diagnosis.json")) ||
    fs.existsSync(path.join(sessionDir, "diagnosis.md"))
  );
}

function writeSessionFileNoSymlink(
  sessionDir: string,
  name: string,
  data: string,
): void {
  const filePath = path.join(sessionDir, name);
  try {
    const root = fs.realpathSync(sessionDir);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      throw new Error("Invalid diagnosis artifact path");
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Invalid diagnosis artifact path");
    }
    fs.writeFileSync(filePath, data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fs.writeFileSync(filePath, data);
      return;
    }
    if (
      err instanceof Error &&
      err.message.includes("Invalid diagnosis artifact path")
    )
      throw err;
    throw new Error("Invalid diagnosis artifact path");
  }
}

function readCandidates(sessionDir: string): EvidenceCandidate[] {
  const filePath = path.join(sessionDir, "candidates.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvidenceCandidate);
}

function selectModel(
  model: string | undefined,
  allowAutoModel: boolean,
): string {
  if (!model) return DEFAULT_MODEL;
  if (model === "openrouter/auto" && !allowAutoModel) return DEFAULT_MODEL;
  return model;
}

function buildPrompt(
  sessionDir: string,
  candidates: EvidenceCandidate[],
  maxWindows: number,
  maxBytes: number,
): string {
  const selected = candidates.slice(0, Math.max(0, maxWindows));
  const chunks = [
    "Rank these Crumbtrail issue candidates. Use the deterministic evidence as source of truth. Return JSON with an array named findings. Each finding should include real_issue, confidence, severity, user_visible_symptom, suspected_root_cause, evidence_refs, recommended_debug_steps, unknowns, and false_positive_reason when rejected.",
    "",
    "Candidate summaries:",
    JSON.stringify(
      selected.map((candidate) => ({
        id: candidate.id,
        detector: candidate.detector,
        severity: candidate.severity,
        score: candidate.score,
        confidence: candidate.confidence,
        anchor: safeAnchor(candidate.anchor),
        evidenceWindow: candidate.evidenceWindow,
      })),
      null,
      2,
    ),
    "",
    "AI-safe evidence references:",
  ];

  for (const candidate of selected) {
    chunks.push(
      JSON.stringify(
        buildAiSafeEvidenceReference(sessionDir, candidate),
        null,
        2,
      ),
    );
  }

  const prompt = chunks.join("\n");
  const promptBytes = Buffer.from(prompt, "utf-8");
  if (promptBytes.byteLength <= maxBytes) return prompt;
  return `${promptBytes.subarray(0, Math.max(0, maxBytes)).toString("utf-8")}\n[TRUNCATED_TO_PROMPT_BYTE_CAP]`;
}

function buildAiSafeEvidenceReference(
  sessionDir: string,
  candidate: EvidenceCandidate,
): Record<string, unknown> {
  const windowPath = path.join(sessionDir, "windows", `${candidate.id}.md`);
  return {
    id: candidate.id,
    windowAvailable: fs.existsSync(windowPath),
    detector: candidate.detector,
    severity: candidate.severity,
    score: candidate.score,
    confidence: candidate.confidence,
    anchor: safeAnchor(candidate.anchor),
    evidenceWindow: candidate.evidenceWindow,
    omittedRawEvidence: [
      "clipboard",
      "keystrokes",
      "transcripts",
      "storage_values",
      "cookies",
      "input_values",
      "console_text",
      "unknown_payloads",
    ],
  };
}

function safeAnchor(
  anchor: EvidenceCandidate["anchor"],
): Record<string, unknown> | undefined {
  if (!anchor || typeof anchor !== "object") return undefined;
  const record = anchor as Record<string, unknown>;
  return {
    ...(typeof record.t === "number" ? { t: record.t } : {}),
    ...(typeof record.k === "string" ? { k: record.k.slice(0, 80) } : {}),
  };
}

function extractContent(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return typeof first.message.content === "string"
    ? first.message.content
    : undefined;
}

function renderDiagnosisMarkdown(diagnosis: Record<string, unknown>): string {
  const lines = [
    "# AI Diagnosis",
    "",
    "Optional OpenRouter ranking over deterministic Crumbtrail candidates.",
    "",
  ];
  const findings = Array.isArray(diagnosis.findings) ? diagnosis.findings : [];
  if (findings.length === 0) {
    lines.push("No findings returned.", "");
    return lines.join("\n");
  }

  for (const [index, finding] of findings.entries()) {
    const record = isRecord(finding) ? finding : {};
    lines.push(`## Finding ${index + 1}`);
    lines.push("");
    for (const key of [
      "real_issue",
      "confidence",
      "severity",
      "user_visible_symptom",
      "suspected_root_cause",
      "evidence_refs",
      "recommended_debug_steps",
      "unknowns",
      "false_positive_reason",
    ]) {
      if (record[key] === undefined) continue;
      lines.push(
        `- ${key}: ${Array.isArray(record[key]) ? (record[key] as unknown[]).join(", ") : String(record[key])}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
