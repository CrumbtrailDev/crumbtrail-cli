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
const NATIVE_STACKS = ["django", "flask", "fastapi", "rails", "go"] as const;

describe("owned native setup", () => {
  // The gate, not the copy. Nothing in NATIVE_PACKAGES resolves from a public
  // registry: crumbtrail-python is not on PyPI, the crumbtrail gem is not on
  // RubyGems, and packages/go exists only on an unmerged branch. Until that
  // changes the CLI must not tell anyone to install one of them.
  it("ships no native package the wizard is allowed to wire an app against", () => {
    for (const [stack, native] of Object.entries(NATIVE_PACKAGES)) {
      expect(native.published, `${stack} claims publication`).toBe(false);
      expect(nativeCaptureSetup(stack as never, keys.endpoint, "orders")).toBe(
        null,
      );
    }
  });

  for (const stack of NATIVE_STACKS) {
    it(`keeps ${stack} on the OTLP path while its package is unpublished`, () => {
      const prompt = buildAgentPrompt(stack, keys, { serviceName: "orders" });
      expect(prompt).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(prompt).not.toContain(NATIVE_PACKAGES[stack]!.package);
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
      expect(guide).not.toContain("Maintained native capture setup");
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
    // No native package is published, so nothing is written beside the tracing
    // edits and every file the plan names is one the reader can act on.
    expect(
      plan.extraEdits?.some((e) =>
        e.path.endsWith("CRUMBTRAIL_NATIVE_SETUP.md"),
      ),
    ).toBe(false);

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
