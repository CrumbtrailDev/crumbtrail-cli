import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  backfillAiDiagnoses,
  runAiDiagnosis,
  scheduleAiDiagnosis,
} from "../ai-diagnosis";

describe("runAiDiagnosis", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-ai-"));
    fs.mkdirSync(path.join(tmpDir, "windows"));
    fs.writeFileSync(
      path.join(tmpDir, "candidates.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "cand_0001",
        detector: "http_error",
        title: "HTTP 500 from POST /api/save",
        severity: "high",
        score: 90,
        confidence: "high",
        anchor: { t: 1000 },
        evidenceWindow: { start: 0, end: 2000, windowId: "win_0001" },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "windows", "cand_0001.md"),
      "# Evidence Window cand_0001\n",
    );
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call fetch without explicit opt-in even when a key exists", async () => {
    let called = false;
    const result = await runAiDiagnosis(tmpDir, {
      enabled: false,
      apiKey: "key",
      fetchImpl: (async () => {
        called = true;
        throw new Error("unexpected");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true, skipped: "opt_in_disabled" });
    expect(called).toBe(false);
  });

  it("skips when opt-in is enabled but the API key is missing", async () => {
    let called = false;
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await runAiDiagnosis(tmpDir, {
        enabled: true,
        fetchImpl: (async () => {
          called = true;
          throw new Error("unexpected");
        }) as typeof fetch,
      });
      expect(result).toMatchObject({ ok: true, skipped: "missing_key" });
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("backfills an existing finalized session with bounded diagnosis work", async () => {
    const result = await backfillAiDiagnoses([tmpDir], {
      enabled: true,
      apiKey: "key",
      backfillConcurrency: 1,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    expect(result).toEqual({
      checked: 1,
      generated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(fs.existsSync(path.join(tmpDir, "diagnosis.json"))).toBe(true);
  });

  it("bounds live scheduled diagnoses with the same provider concurrency", async () => {
    const copies = ["session-2", "session-3"].map((name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(path.join(dir, "windows"), { recursive: true });
      fs.copyFileSync(
        path.join(tmpDir, "candidates.jsonl"),
        path.join(dir, "candidates.jsonl"),
      );
      return dir;
    });
    let providerCalls = 0;
    const releases: Array<() => void> = [];
    const config = {
      enabled: true,
      apiKey: "key",
      backfillConcurrency: 1,
      fetchImpl: (async () => {
        providerCalls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    };

    for (const dir of [tmpDir, ...copies]) scheduleAiDiagnosis(dir, config);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(providerCalls).toBe(1);

    releases.shift()?.();
    await waitFor(() => providerCalls === 2);
    releases.shift()?.();
    await waitFor(() => providerCalls === 3);
    releases.shift()?.();
    await waitFor(() =>
      copies.every((dir) => fs.existsSync(path.join(dir, "diagnosis.json"))),
    );
  });

  it("reports malformed candidate files without calling the provider", async () => {
    fs.writeFileSync(path.join(tmpDir, "candidates.jsonl"), "{not json}\n");
    let called = false;
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () => {
        called = true;
        throw new Error("unexpected");
      }) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("reports provider errors without writing diagnosis artifacts", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response("nope", { status: 503 })) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      error: "OpenRouter request failed with HTTP 503",
    });
    expect(fs.existsSync(path.join(tmpDir, "diagnosis.md"))).toBe(false);
  });

  it("reports malformed model JSON without writing diagnosis artifacts", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{not json" } }],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "diagnosis.md"))).toBe(false);
  });

  it("bounds AI input to top 40 candidates and the configured prompt byte cap", async () => {
    const candidates = Array.from({ length: 45 }, (_, i) => ({
      schemaVersion: 1,
      id: `cand_${String(i + 1).padStart(4, "0")}`,
      detector: "console_error",
      title: `Candidate ${i + 1} ${"x".repeat(200)}`,
      severity: "low",
      score: 45 - i,
      confidence: "medium",
      anchor: { t: i },
      evidenceWindow: { start: i, end: i + 1, windowId: "win_0001" },
    }));
    fs.writeFileSync(
      path.join(tmpDir, "candidates.jsonl"),
      candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
        "\n",
    );
    for (const candidate of candidates) {
      fs.writeFileSync(
        path.join(tmpDir, "windows", `${candidate.id}.md`),
        `# ${candidate.id} ${"y".repeat(200)}\n`,
      );
    }

    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      maxPromptBytes: 1_000_000,
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(requestBody).toContain("cand_0040");
    expect(requestBody).not.toContain("cand_0041");
    fs.rmSync(path.join(tmpDir, "diagnosis.json"), { force: true });
    fs.rmSync(path.join(tmpDir, "diagnosis.md"), { force: true });

    const cappedResult = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      maxPromptBytes: 2_000,
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(cappedResult.ok).toBe(true);
    expect(requestBody).toContain("TRUNCATED_TO_PROMPT_BYTE_CAP");
  });

  it("does not send raw evidence window text to OpenRouter", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "windows", "cand_0001.md"),
      [
        "# Evidence Window cand_0001",
        "clip txt: copy this password hunter2",
        "key: secret-keystrokes-123",
        "tx: private transcript text",
        "console: runtime snippet with sk_fake_abcdefghijklmnopqrstuvwxyz",
        "unknown payload raw-sensitive-value",
      ].join("\n"),
    );

    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(requestBody).toContain("cand_0001");
    expect(requestBody).not.toContain("hunter2");
    expect(requestBody).not.toContain("secret-keystrokes-123");
    expect(requestBody).not.toContain("private transcript text");
    expect(requestBody).not.toContain("sk_fake_");
    expect(requestBody).not.toContain("raw-sensitive-value");
  });

  it("does not write diagnosis artifacts through symlinks created while the provider is running", async () => {
    const outsideFile = path.join(
      os.tmpdir(),
      `crumbtrail-diagnosis-outside-${Date.now()}.json`,
    );
    fs.writeFileSync(outsideFile, "outside");

    try {
      const result = await runAiDiagnosis(tmpDir, {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          fs.symlinkSync(outsideFile, path.join(tmpDir, "diagnosis.json"));
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ findings: [] }) } },
              ],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid diagnosis artifact path");
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("writes diagnosis artifacts from fake OpenRouter JSON, including rejected candidates", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    findings: [
                      {
                        real_issue: false,
                        confidence: "medium",
                        severity: "low",
                        evidence_refs: ["cand_0001"],
                        false_positive_reason: "Synthetic test rejection",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(tmpDir, "diagnosis.md"), "utf-8"),
    ).toContain("cand_0001");
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, "diagnosis.json"), "utf-8"))
        .findings[0].false_positive_reason,
    ).toBe("Synthetic test rejection");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for diagnosis work");
}
