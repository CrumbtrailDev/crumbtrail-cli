import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../install/index";
import { renderOtlpGuide } from "../otlp-guide";
import { buildPlan } from "../inject/recipes";
import { fakeInjectIO } from "./helpers";

const keys = { endpoint: "https://capture.example", apiKey: "never-inline" };
describe("owned native setup", () => {
  for (const stack of ["django", "flask", "fastapi", "rails", "go"] as const) {
    it(`routes ${stack} to package ownership without asserting publication`, () => {
      const prompt = buildAgentPrompt(stack, keys, { serviceName: "orders" });
      expect(prompt).toContain("verified local package source");
      expect(prompt).toContain("If unavailable");
      expect(prompt).toContain("No eligible routes means no native capture");
      expect(prompt).toContain("existing browser session");
      expect(prompt).toContain(
        "SQL text, parameters and row values are withheld",
      );
      expect(prompt).toContain("Do not copy or implement middleware");
      expect(prompt).not.toContain(keys.apiKey);
      const guide = renderOtlpGuide({
        stack,
        serviceName: "orders",
        endpoint: keys.endpoint,
        snippet: "existing OTLP",
        agentPrompt: prompt,
      });
      expect(guide).toContain("existing OTLP");
      expect(guide).toContain(prompt);
    });
  }
  it("adds native instructions beside automatic Python tracing without overwriting customer instructions", () => {
    const files = {
      "/proj/requirements.txt": "fastapi\n",
      "/proj/Procfile": "web: uvicorn app:app\n",
    };
    const input = {
      cwd: "/proj",
      recipe: "otlp" as const,
      stack: "fastapi" as const,
      endpoint: keys.endpoint,
    };
    const plan = buildPlan(input, fakeInjectIO(files));
    expect(plan.content).toContain("python crumbtrail_otel.py");
    expect(
      plan.extraEdits?.find((e) =>
        e.path.endsWith("CRUMBTRAIL_NATIVE_SETUP.md"),
      )?.content,
    ).toContain("crumbtrail-python");
    const alreadyTraced = buildPlan(
      input,
      fakeInjectIO({
        ...files,
        "/proj/Procfile": plan.content!,
        ...Object.fromEntries(
          (plan.extraEdits ?? [])
            .filter((e) => !e.path.endsWith("CRUMBTRAIL_NATIVE_SETUP.md"))
            .map((e) => [e.path, e.content]),
        ),
      }),
    );
    expect(alreadyTraced.kind).toBe("create");
    expect(alreadyTraced.targetPath).toBe("/proj/CRUMBTRAIL_NATIVE_SETUP.md");
    expect(alreadyTraced.extraEdits).toBeUndefined();
    const existing = buildPlan(
      input,
      fakeInjectIO({
        ...files,
        "/proj/CRUMBTRAIL_NATIVE_SETUP.md": "customer instructions",
      }),
    );
    expect(
      existing.extraEdits?.some((e) =>
        e.path.endsWith("CRUMBTRAIL_NATIVE_SETUP.md"),
      ),
    ).toBe(false);
  });
});
