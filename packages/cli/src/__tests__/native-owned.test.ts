import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../install/index";
import { renderOtlpGuide } from "../otlp-guide";
import { buildPlan } from "../inject/recipes";
import {
  NATIVE_PACKAGES,
  nativeCaptureSetup,
  renderNativeCaptureSetup,
} from "../native-owned";
import { fakeInjectIO } from "./helpers";

const keys = { endpoint: "https://capture.example", apiKey: "bl_live_secret" };
// Every native package resolves from its registry now: crumbtrail-python on
// PyPI, the crumbtrail gem on RubyGems, and the Go module at packages/go/v0.1.0.
const PUBLISHED_STACKS = [
  "django",
  "flask",
  "fastapi",
  "rails",
  "go",
] as const;

describe("owned native setup", () => {
  // The gate, not the copy. A stack may only be wired against an artifact that
  // resolves from its public registry today.
  it("wires an app only against a package that resolves from its registry", () => {
    for (const stack of PUBLISHED_STACKS) {
      expect(NATIVE_PACKAGES[stack]!.published, stack).toBe(true);
      expect(
        nativeCaptureSetup(stack, keys.endpoint, "orders"),
        stack,
      ).not.toBe(null);
    }
    // Nothing is gated today, so the gate is proven on its other arm: a stack
    // with no entry gets no native guidance, which is what keeps the OTLP
    // prompt the answer for a stack added before its artifact ships.
    expect(nativeCaptureSetup("node", keys.endpoint, "orders")).toBe(null);
  });

  for (const stack of PUBLISHED_STACKS) {
    it(`points ${stack} at its published package`, () => {
      const prompt = buildAgentPrompt(stack, keys, { serviceName: "orders" });
      expect(prompt).toContain(NATIVE_PACKAGES[stack]!.package);
      expect(prompt).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(prompt).not.toContain(keys.apiKey);
      for (const step of NATIVE_PACKAGES[stack]!.registration) {
        expect(prompt).toContain(step);
      }

      // The caller says the prompt already is the native setup, so the guide
      // must not print the same block twice.
      const guide = renderOtlpGuide({
        stack,
        serviceName: "orders",
        endpoint: keys.endpoint,
        snippet: "existing OTLP",
        agentPrompt: prompt,
        agentPromptIsNativeSetup: true,
      });
      expect(guide).toContain("existing OTLP");
      expect(guide).toContain(prompt);
      expect(guide).not.toContain("## Maintained native capture setup");
    });
  }


  // The body is checked directly so the gate above does not have to be defeated
  // to prove the guidance is right when it eventually ships.
  it("names only APIs that exist in each package's source", () => {
    const python = renderNativeCaptureSetup(
      NATIVE_PACKAGES.flask!,
      keys.endpoint,
      "orders",
      { hasExplicitServiceName: true },
    );
    expect(python).toContain(
      "crumbtrail.Client(service=..., should_capture=...)",
    );
    expect(python).toContain("crumbtrail.flask.install(app, client)");
    expect(python).toContain(
      "crumbtrail.database.instrument_sqlalchemy(engine)",
    );
    expect(python).toContain("client.close(timeout=5)");

    expect(
      renderNativeCaptureSetup(NATIVE_PACKAGES.rails!, keys.endpoint, "orders"),
    ).toContain("Crumbtrail::ActiveRecord.install(engine:)");
    expect(
      renderNativeCaptureSetup(NATIVE_PACKAGES.go!, keys.endpoint, "orders"),
    ).toContain("crumbtrail.WrapDB(db, engine)");
  });

  it("names the caller's key variable and drops the HTTPS claim", () => {
    const body = renderNativeCaptureSetup(
      NATIVE_PACKAGES.django!,
      "http://localhost:19890",
      "orders",
      { keyEnv: "CRUMBTRAIL_KEY", hasExplicitServiceName: true },
    );
    expect(body).toContain("CRUMBTRAIL_ENDPOINT and CRUMBTRAIL_KEY");
    expect(body).not.toContain("CRUMBTRAIL_INGEST_KEY");
    expect(body).not.toContain("HTTPS");
  });

  it("asks for a stable app name only when none was resolved", () => {
    const replace =
      "Replace <your-app-name> with a stable name for this app before running it.";
    expect(
      renderNativeCaptureSetup(
        NATIVE_PACKAGES.django!,
        keys.endpoint,
        "orders",
        { hasExplicitServiceName: true },
      ),
    ).not.toContain(replace);
    expect(
      renderNativeCaptureSetup(
        NATIVE_PACKAGES.django!,
        keys.endpoint,
        "<your-app-name>",
      ),
    ).toContain(replace);
  });

  it("reports an already-wired Python project as set up rather than recreating a guide", () => {
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
    // crumbtrail-python resolves, so the plan writes the native guide beside the
    // tracing edits and names the package the reader can actually install.
    const guide = plan.extraEdits?.find((e) =>
      e.path.endsWith("CRUMBTRAIL_NATIVE_SETUP.md"),
    );
    expect(guide).toBeDefined();
    expect(guide!.content).toContain(NATIVE_PACKAGES.fastapi!.package);

    const alreadyTraced = buildPlan(
      input,
      fakeInjectIO({
        ...files,
        "/proj/Procfile": plan.content!,
        ...Object.fromEntries(
          (plan.extraEdits ?? []).map((e) => [e.path, e.content]),
        ),
      }),
    );
    expect(alreadyTraced.kind).toBe("skip-already-wired");
    expect(alreadyTraced.keyEnvVar).toBe("CRUMBTRAIL_KEY");
  });
});
