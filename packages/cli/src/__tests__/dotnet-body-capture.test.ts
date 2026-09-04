import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { classifyStructuredValue } from "crumbtrail-core";
import { DOTNET_STRUCTURED_BODY_SOURCE } from "../dotnet-body-capture";
import { renderOtlpGuide } from "../otlp-guide";

it("includes the reusable source only in the manual dotnet guide", () => {
  const input = {
    serviceName: "api",
    endpoint: "https://capture.example",
    snippet: "export OTEL_SERVICE_NAME=api",
    agentPrompt: "Configure tracing",
  };
  expect(renderOtlpGuide({ ...input, stack: "dotnet" })).toContain(
    DOTNET_STRUCTURED_BODY_SOURCE,
  );
  expect(renderOtlpGuide({ ...input, stack: "rails" })).not.toContain(
    DOTNET_STRUCTURED_BODY_SOURCE,
  );
});

it.skipIf(!process.env.CRUMBTRAIL_DOTNET)(
  "compiles the reusable producer and checks its output against canonical redaction",
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-profile-"));
    try {
      fs.writeFileSync(
        path.join(dir, "Profile.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>',
      );
      fs.writeFileSync(
        path.join(dir, "StructuredBody.cs"),
        DOTNET_STRUCTURED_BODY_SOURCE,
      );
      fs.writeFileSync(
        path.join(dir, "Program.cs"),
        "using Crumbtrail; using System.Text; using System.Text.Json; string? line; while ((line=Console.ReadLine()) is not null) Console.WriteLine(JsonSerializer.Serialize(StructuredBody.Capture(Encoding.UTF8.GetBytes(line))));",
      );
      const dotnet = process.env.CRUMBTRAIL_DOTNET!;
      execFileSync(dotnet, ["build", "--nologo", "--verbosity", "quiet"], {
        cwd: dir,
      });
      const inputs = [
        ...[
          "sk",
          "pk",
          "rk",
          "ghp",
          "gho",
          "ghu",
          "ghs",
          "glpat",
          "xoxb",
          "xoxa",
          "xoxp",
          "xoxr",
          "xoxs",
        ].map((prefix) => ({ value: `${prefix}_abcdefghijkl` })),
        {
          entityId: 731,
          amount: 18.75,
          unit: "CAD",
          status: "accepted",
          count: null,
          active: true,
        },
        {
          nested: { credentials: { pin: 1234 }, amount: 12 },
          rows: [{ email: "a@example.com", amount: -2.25 }],
        },
        {
          password: "secret",
          first_name: "Jane",
          dateOfBirth: "1990-01-02",
          value: "a@example.com",
        },
        {
          a: 4111111111111111,
          b: 999999999999999999,
          c: "GB29NWBK60161331926819",
          d: "[REDACTED]",
        },
        {
          value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
          other: "Bearer abcdef",
        },
        { value: "sk_test_abcdefghijklmno", other: "ABCDEFGHijklmnopqrstUVWX" },
        {
          shipping: 4,
          company: true,
          pwd2: "secret",
          otpCode: 1234,
          userPass: "secret",
          api_key: "secret",
        },
        { value: "123456789", lower: "pending_review", unit: "USD" },
      ];
      const rawInputs = [
        ...inputs.map((value) => JSON.stringify(value)),
        '{"extreme":-79228162514264337593543950335}',
        '{"amount":1,"amount":2}',
        '{"amount":',
        "x".repeat(16385),
      ];
      const lines = execFileSync(
        dotnet,
        [path.join(dir, "bin/Debug/net9.0/Profile.dll")],
        { input: rawInputs.join("\n") + "\n", encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const check = (value: unknown, key?: string) => {
        if (value === "[REDACTED]") return;
        if (Array.isArray(value)) {
          for (const item of value) check(item, key);
          return;
        }
        if (value !== null && typeof value === "object") {
          for (const [name, item] of Object.entries(value)) check(item, name);
          return;
        }
        expect(
          classifyStructuredValue(value, key).action,
          `${key}: ${JSON.stringify(value)}`,
        ).toBe("keep");
      };
      for (const result of lines.slice(0, inputs.length)) {
        expect(result.Body).not.toBeNull();
        check(JSON.parse(result.Body));
        for (const forbidden of [
          "secret",
          "a@example.com",
          "4111111111111111",
          "Jane",
          "GB29NWBK",
          "Bearer abcdef",
          "eyJhb",
          "ABCDEFGH",
        ])
          expect(result.Body).not.toContain(forbidden);
      }
      const operandIndex = inputs.findIndex((input) => "entityId" in input);
      expect(JSON.parse(lines[operandIndex].Body)).toEqual(
        inputs[operandIndex],
      );
      expect(lines[inputs.length].Body).not.toContain("792281625");
      expect(lines.slice(-3).map((result) => result.State)).toEqual([
        "invalid",
        "invalid",
        "truncated",
      ]);
      expect(lines.slice(-3).every((result) => result.Body === null)).toBe(
        true,
      );
      if (process.env.CRUMBTRAIL_DOTNET_ADAPTER_SOURCE) {
        expect(
          fs.readFileSync(process.env.CRUMBTRAIL_DOTNET_ADAPTER_SOURCE, "utf8"),
        ).toBe(DOTNET_STRUCTURED_BODY_SOURCE);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
