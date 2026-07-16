import { describe, it, expect, vi } from "vitest";
import { parseArgs, startupMessages, runCli, isCliEntrypoint } from "../cli";
import { readPackageVersion } from "../version";

async function captureLog(run: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return logs.join("\n");
}

describe("runCli --version", () => {
  it("prints the crumbtrail-node package version for --version", async () => {
    const out = await captureLog(() => runCli(["--version"]));
    expect(out.trim()).toBe(readPackageVersion());
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the version for the -v alias", async () => {
    const out = await captureLog(() => runCli(["-v"]));
    expect(out.trim()).toBe(readPackageVersion());
  });
});

describe("isCliEntrypoint", () => {
  it("recognizes source, bundle, and installed package bin names", () => {
    expect(isCliEntrypoint("/repo/packages/node/src/cli.ts")).toBe(true);
    expect(isCliEntrypoint("/repo/packages/node/dist/cli.cjs")).toBe(true);
    expect(isCliEntrypoint("/usr/local/bin/crumbtrail")).toBe(true);
    expect(isCliEntrypoint("/usr/local/bin/crumbtrail-server")).toBe(true);
  });

  it("does not treat arbitrary importers as the CLI process", () => {
    expect(isCliEntrypoint(undefined)).toBe(false);
    expect(
      isCliEntrypoint("/repo/packages/node/src/__tests__/cli.test.ts"),
    ).toBe(false);
  });
});

describe("runCli per-subcommand --help", () => {
  it.each([
    "serve",
    "init",
    "doctor",
    "scan",
    "fix-context",
    "inspect",
    "compare",
  ])(
    "prints focused help for `%s --help` with flags and an example",
    async (sub) => {
      const out = await captureLog(() => runCli([sub, "--help"]));
      expect(out).toContain(`crumbtrail-server ${sub}`);
      expect(out).toContain("Options:");
      expect(
        out.includes("Example:") || out.includes("Examples:"),
      ).toBeTruthy();
    },
  );

  it("documents the --latest/--follow flags in fix-context help", async () => {
    const out = await captureLog(() => runCli(["fix-context", "--help"]));
    expect(out).toContain("--latest");
    expect(out).toContain("--follow");
    expect(out).toContain("--interval <ms>");
    expect(out).toContain("--timeout <ms>");
    expect(out).toContain("fix-context --latest --follow --json");
  });

  it("honors the -h alias per subcommand", async () => {
    const out = await captureLog(() => runCli(["scan", "-h"]));
    expect(out).toContain("crumbtrail-server scan");
  });

  it("still shows top-level help for a bare --help", async () => {
    const out = await captureLog(() => runCli(["--help"]));
    expect(out).toContain("AI-readable app evidence sessions");
    expect(out).toContain("inspect");
  });
});

describe("runCli init --provider", () => {
  it("prints a provider OTLP config without running project init", async () => {
    const out = await captureLog(() =>
      runCli(["init", "--provider", "datadog", "--port", "19898"]),
    );
    expect(out).toContain("# Datadog -> Crumbtrail");
    expect(out).toContain("otlphttp/crumbtrail");
    expect(out).toContain("endpoint: http://127.0.0.1:19898");
  });

  it("rejects unknown providers", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        errors.push(String(chunk));
        return true;
      });
    try {
      await expect(runCli(["init", "--provider", "unknown"])).resolves.toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("")).toContain("--provider must be one of");
  });
});

describe("parseArgs", () => {
  it("uses defaults when no args provided", () => {
    const result = parseArgs([]);
    expect(result.port).toBe(9898);
    expect(result.output).toContain(".crumbtrail/sessions");
    expect(result.host).toBe("127.0.0.1");
  });

  it("parses --port flag", () => {
    const result = parseArgs(["--port", "3000"]);
    expect(result.port).toBe(3000);
  });

  it("parses --output flag", () => {
    const result = parseArgs(["--output", "/tmp/sessions"]);
    expect(result.output).toBe("/tmp/sessions");
  });

  it("parses both flags together", () => {
    const result = parseArgs(["--port", "4000", "--output", "/my/sessions"]);
    expect(result.port).toBe(4000);
    expect(result.output).toBe("/my/sessions");
  });

  it("defaults whisperModel to base", () => {
    const result = parseArgs([]);
    expect(result.whisperModel).toBe("base");
  });

  it("parses --whisper-model flag", () => {
    const result = parseArgs(["--whisper-model", "tiny"]);
    expect(result.whisperModel).toBe("tiny");
  });

  it("parses all flags together", () => {
    const result = parseArgs([
      "--port",
      "5000",
      "--output",
      "/tmp/out",
      "--whisper-model",
      "large",
    ]);
    expect(result.port).toBe(5000);
    expect(result.output).toBe("/tmp/out");
    expect(result.whisperModel).toBe("large");
  });

  it("parses --host flag", () => {
    const result = parseArgs(["--host", "0.0.0.0"]);
    expect(result.host).toBe("0.0.0.0");
  });

  it("parses --auth-token and --allow-origin flags", () => {
    const result = parseArgs([
      "--auth-token",
      "secret-token",
      "--allow-origin",
      "https://app.example.com",
      "--allow-origin",
      "http://localhost:3000",
    ]);
    expect(result.authToken).toBe("secret-token");
    expect(result.allowedOrigins).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it("defaults mcp to false", () => {
    const result = parseArgs([]);
    expect(result.mcp).toBe(false);
  });

  it("parses --mcp flag", () => {
    const result = parseArgs(["--mcp"]);
    expect(result.mcp).toBe(true);
  });

  it("parses --mcp with other flags", () => {
    const result = parseArgs(["--mcp", "--output", "/tmp/mcp-sessions"]);
    expect(result.mcp).toBe(true);
    expect(result.output).toBe("/tmp/mcp-sessions");
  });

  it("parses explicit AI opt-in flags", () => {
    const result = parseArgs([
      "--ai",
      "--ai-model",
      "openai/gpt-4.1-mini",
      "--ai-allow-auto-model",
    ]);
    expect(result.ai).toBe(true);
    expect(result.aiModel).toBe("openai/gpt-4.1-mini");
    expect(result.aiAllowAutoModel).toBe(true);
  });
});

describe("startupMessages", () => {
  it("reports the resolved local runtime without optional features", () => {
    expect(
      startupMessages(
        parseArgs([
          "--host",
          "127.0.0.1",
          "--port",
          "9898",
          "--output",
          "/tmp/sessions",
        ]),
      ),
    ).toEqual([
      "crumbtrail-server listening on http://127.0.0.1:9898",
      "Sessions saved to: /tmp/sessions",
    ]);
  });

  it("reports optional features without leaking auth token content", () => {
    const messages = startupMessages(
      parseArgs([
        "--host",
        "0.0.0.0",
        "--port",
        "9999",
        "--output",
        "/tmp/sessions",
        "--static",
        "/tmp/static",
        "--allow-origin",
        "https://app.example.com",
        "--allow-origin",
        "http://localhost:5173",
        "--auth-token",
        "super-secret-token",
        "--ai",
        "--ai-model",
        "openai/gpt-4.1-mini",
      ]),
    );

    expect(messages).toContain(
      "crumbtrail-server listening on http://0.0.0.0:9999",
    );
    expect(messages).toContain("Sessions saved to: /tmp/sessions");
    expect(messages).toContain("Serving static files from: /tmp/static");
    expect(messages).toContain(
      "WARNING: non-loopback host binding exposes captured Crumbtrail evidence on the network; use --auth-token and trusted network controls.",
    );
    expect(messages).toContain("Allowed browser origins: 2 configured");
    expect(messages).toContain(
      "Auth token protection enabled for /api/* routes",
    );
    expect(messages).toContain(
      "AI opinion opt in enabled with model openai/gpt-4.1-mini",
    );
    expect(messages.join("\n")).not.toContain("super-secret-token");
  });
});
