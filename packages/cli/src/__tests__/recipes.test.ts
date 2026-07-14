import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildPlan, supportsInstrumentationClient } from "../inject/recipes";
import { fakeInjectIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
const KEY = "bl_ingest_abc123";
const p = (...parts: string[]) => path.join(CWD, ...parts);

describe("supportsInstrumentationClient", () => {
  it("is true for >=15.3 and non-numeric ranges, false below", () => {
    expect(supportsInstrumentationClient("15.4.0")).toBe(true);
    expect(supportsInstrumentationClient("^16.0.0")).toBe(true);
    expect(supportsInstrumentationClient("latest")).toBe(true);
    expect(supportsInstrumentationClient(null)).toBe(true);
    expect(supportsInstrumentationClient("15.2.0")).toBe(false);
    expect(supportsInstrumentationClient("14.1.0")).toBe(false);
  });
});

describe("buildPlan — Next.js", () => {
  it("creates instrumentation-client.ts for modern Next with the real key inlined", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("instrumentation-client.ts"));
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain(`httpAuthToken: "${KEY}"`);
    expect(plan.content).toContain('from "crumbtrail-core"');
  });

  it("prefers src/ when the app uses a src directory", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "app")]: "", // marker: exists() returns true for this key
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.targetPath).toBe(p("src", "instrumentation-client.ts"));
  });

  // Regression (CP2): a legacy (<15.3) app-router-ONLY project must NEVER prepend
  // client init into app/layout.tsx — the root layout is a Server Component that
  // never ships to the browser, so that path silently captures nothing. It must
  // hand off to the AI/guidance path with a "use client" / Server Component note.
  it("falls back (not prepend) for legacy app-router-only Next — app/layout is a Server Component", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app", "layout.tsx")]: "export default function L() {}\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "14.2.0",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toMatch(/use client|Server Component/i);
    expect(plan.snippet).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.agentPrompt).toContain(KEY);
  });

  it("prepends into pages/_app.tsx for legacy Next with a Pages Router", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("pages", "_app.tsx")]:
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "14.2.0",
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("pages", "_app.tsx"));
    expect(plan.warnings.join(" ")).toMatch(/pages\/_app/i);
  });

  it("prepends into pages/_app when BOTH pages/_app and app/layout exist (client-safe wins)", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("pages", "_app.tsx")]: "export default function App() {}\n",
      [p("app", "layout.tsx")]: "export default function L() {}\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "14.2.0",
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("pages", "_app.tsx"));
  });

  it("uses the INSTALLED next version over the declared range (probe wins: modern)", () => {
    // Declared range is legacy-looking, but node_modules resolved to 15.4.2 →
    // the modern instrumentation-client.ts path must be taken.
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app", "layout.tsx")]: "export default function L() {}\n",
      [p("node_modules", "next", "package.json")]: JSON.stringify({
        name: "next",
        version: "15.4.2",
      }),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "14.0.0",
      },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("instrumentation-client.ts"));
  });

  it("uses the INSTALLED next version over the declared range (probe wins: legacy)", () => {
    // Declared range says modern (^15), but node_modules resolved to a legacy
    // 14.2.0 → must take the legacy path (fallback for app-router-only).
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app", "layout.tsx")]: "export default function L() {}\n",
      [p("node_modules", "next", "package.json")]: JSON.stringify({
        name: "next",
        version: "14.2.0",
      }),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "^15",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toMatch(/use client|Server Component/i);
  });

  it("falls back to AI when older Next has no layout/_app", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "13.0.0",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(KEY);
  });
});

describe("buildPlan — idempotency", () => {
  it("skips when package.json already depends on crumbtrail-core", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-core": "0.1.0" },
      }),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });

  it("skips when the target file already references crumbtrail", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("instrumentation-client.ts")]:
        'import { Crumbtrail } from "crumbtrail-core";\n',
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        apiKey: KEY,
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });
});

describe("buildPlan — SvelteKit / Nuxt", () => {
  it("creates src/hooks.client.ts for SvelteKit when absent", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "sveltekit", endpoint: ENDPOINT, apiKey: KEY },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("src", "hooks.client.ts"));
  });

  it("prepends into an existing hooks.client.ts", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "hooks.client.ts")]: "export const handleError = () => {};\n",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "sveltekit", endpoint: ENDPOINT, apiKey: KEY },
      io,
    );
    expect(plan.kind).toBe("prepend");
  });

  it("creates a Nuxt client plugin wrapped in defineNuxtPlugin", () => {
    // No app/ dir (Nuxt 3 default): the plugin lands in the repo-root plugins/.
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "nuxt", endpoint: ENDPOINT, apiKey: KEY },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("plugins", "crumbtrail.client.ts"));
    expect(plan.content).toContain("defineNuxtPlugin");
  });

  // Nuxt 4's default srcDir is app/, so plugins live in app/plugins/. When app/
  // exists the plugin MUST target app/plugins/crumbtrail.client.ts — a root
  // plugins/ file is never scanned by Nuxt 4 (silent zero-capture). Mirrors
  // planNext's usesSrc probe idiom.
  it("creates the Nuxt plugin under app/plugins when app/ exists (Nuxt 4 srcDir)", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app")]: "", // marker: exists() is true for the app/ dir
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "nuxt", endpoint: ENDPOINT, apiKey: KEY },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("app", "plugins", "crumbtrail.client.ts"));
    expect(plan.content).toContain("defineNuxtPlugin");
  });
});

describe("buildPlan — React Native", () => {
  it("prepends the imperative createReactNativeCrumbtrail block into the entry", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("App.tsx")]: "export default function App() {}\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "react-native",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("App.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("createReactNativeCrumbtrail");
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain(`httpAuthToken: "${KEY}"`);
    // Must NOT wrap a Provider — the engine can't transform JSX.
    expect(plan.content).not.toContain("CrumbtrailReactNativeProvider");
  });

  it("falls back to AI when the RN entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "react-native",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain("createReactNativeCrumbtrail");
    expect(plan.agentPrompt).toContain(KEY);
  });
});

describe("buildPlan — Tauri", () => {
  it("prepends the transportInstance init block into the frontend entry", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "render();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "tauri",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("transportInstance: new TauriTransport()");
    expect(plan.content).toContain('from "crumbtrail-tauri"');
    // transportInstance override, NOT the `transport` string-mode field.
    expect(plan.content).not.toMatch(/transport:\s*new TauriTransport/);
    // The JS injection alone is inert without the two Rust-side steps — the plan
    // must warn about BOTH (plugin registration + capability permission).
    const warnings = plan.warnings.join("\n");
    expect(warnings).toContain("tauri-plugin-crumbtrail");
    expect(warnings).toContain("crumbtrail:default");
  });

  it("falls back to AI when the Tauri entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "tauri",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain("transportInstance: new TauriTransport()");
    // Even on the fallback path the Rust-side steps must be named.
    const warnings = plan.warnings.join("\n");
    expect(warnings).toContain("tauri-plugin-crumbtrail");
    expect(warnings).toContain("crumbtrail:default");
  });

  it("skips when the project already references crumbtrail", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({
        dependencies: { "crumbtrail-core": "0.1.0" },
      }),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "tauri",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });
});

describe("buildPlan — dirty file + ambiguity", () => {
  it("returns needs-confirm-dirty when the target is dirty", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("src", "main.tsx")]: "render();\n" },
      { dirty: [p("src", "main.tsx")] },
    );
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("needs-confirm-dirty");
  });

  it("prepends a dirty target when force is set", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("src", "main.tsx")]: "render();\n" },
      { dirty: [p("src", "main.tsx")] },
    );
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.tsx"),
        options: { force: true },
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
  });

  it("falls back to AI with a filled snippet when the entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(KEY);
  });
});

describe("buildPlan — backend-JS recipes (express/hono/fastify)", () => {
  for (const recipe of ["express", "hono", "fastify"] as const) {
    it(`${recipe}: prepends the headless-session block + env action when the entry resolves`, () => {
      const io = fakeInjectIO(
        { [p("package.json")]: "{}", [p("server.js")]: "x\n" },
        { gitignore: ".env\n" },
      );
      const plan = buildPlan(
        {
          cwd: CWD,
          recipe,
          endpoint: ENDPOINT,
          apiKey: KEY,
          entryFile: p("server.js"),
        },
        io,
      );
      expect(plan.kind).toBe("prepend");
      expect(plan.recipe).toBe(recipe);
      expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
      expect(plan.content).toContain("autoCapture");
      expect(plan.envAction?.line).toBe(`CRUMBTRAIL_KEY=${KEY}`);
      // Non-Nest backends keep Prettier's default double-quote snippet; only
      // Nest forks to single quotes (BUG-12).
      expect(plan.content).toContain('import("crumbtrail-node")');
      expect(plan.content).toContain(`endpoint: "${ENDPOINT}"`);
    });

    it(`${recipe}: needs-confirm-dirty when the entry is dirty`, () => {
      const io = fakeInjectIO(
        { [p("package.json")]: "{}", [p("server.js")]: "x\n" },
        { dirty: [p("server.js")] },
      );
      const plan = buildPlan(
        {
          cwd: CWD,
          recipe,
          endpoint: ENDPOINT,
          apiKey: KEY,
          entryFile: p("server.js"),
        },
        io,
      );
      expect(plan.kind).toBe("needs-confirm-dirty");
    });

    it(`${recipe}: falls back to AI with the backend agent prompt when the entry is unresolved`, () => {
      const io = fakeInjectIO({ [p("package.json")]: "{}" });
      const plan = buildPlan(
        { cwd: CWD, recipe, endpoint: ENDPOINT, apiKey: KEY, entryFile: null },
        io,
      );
      expect(plan.kind).toBe("fallback-ai");
      expect(plan.snippet).toContain(ENDPOINT);
      expect(plan.agentPrompt).toContain(KEY);
      expect(plan.agentPrompt).toContain("crumbtrail-node");
    });

    it(`${recipe}: skips when the project already references crumbtrail`, () => {
      const io = fakeInjectIO({
        [p("package.json")]: JSON.stringify({
          dependencies: { "crumbtrail-node": "0.1.0" },
        }),
      });
      const plan = buildPlan(
        {
          cwd: CWD,
          recipe,
          endpoint: ENDPOINT,
          apiKey: KEY,
          entryFile: p("server.js"),
        },
        io,
      );
      expect(plan.kind).toBe("skip-already-wired");
    });
  }
});

describe("buildPlan — backend fallback prompt is stack-appropriate", () => {
  // The AI fallback prompt must reflect the real crumbtrail-node surface:
  // Express is the only stack with framework middleware; hono + fastify (node)
  // wire a headless session instead. No invented names in any of them.
  const fallback = (recipe: "express" | "hono" | "fastify") => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe, endpoint: ENDPOINT, apiKey: KEY, entryFile: null },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    return plan.agentPrompt ?? "";
  };

  it("express: uses the real Express middleware exports", () => {
    const prompt = fallback("express");
    expect(prompt).toContain("createCrumbtrailExpressMiddleware");
    expect(prompt).toContain("createCrumbtrailExpressErrorMiddleware");
    expect(prompt).not.toContain("startHeadlessSession");
    expect(prompt).not.toContain("attachCrumbtrail");
  });

  for (const recipe of ["hono", "fastify"] as const) {
    it(`${recipe}: uses a headless session, not Express middleware`, () => {
      const prompt = fallback(recipe);
      expect(prompt).toContain("startHeadlessSession");
      expect(prompt).not.toContain("createCrumbtrailExpressMiddleware");
      expect(prompt).not.toContain("attachCrumbtrail");
    });
  }
});

describe("buildPlan — Remix", () => {
  it("prepends the client init into the resolved entry.client", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app", "entry.client.tsx")]: "hydrateRoot();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "remix",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("app", "entry.client.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("app", "entry.client.tsx"));
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain('from "crumbtrail-core"');
  });

  it("falls back to AI (never creates) when entry.client is absent", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "remix",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(KEY);
  });

  // React Router 7's default template hides the client entry until the user runs
  // `npx react-router reveal`. The fallback warning must name that concrete
  // escape hatch rather than only saying "wire it manually".
  it("names `npx react-router reveal` when the RR7 client entry is hidden", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "remix",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toContain("npx react-router reveal");
  });
});

describe("buildPlan — Astro", () => {
  it("always falls back to a guided snippet even with no entry", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "astro",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.snippet).toContain('from "crumbtrail-core"');
    expect(plan.agentPrompt).toContain(KEY);
    expect(plan.warnings.join(" ")).toMatch(/layout/i);
  });
});

describe("buildPlan — Angular", () => {
  it("prepends the client init into src/main.ts", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "bootstrapApplication(AppComponent);\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "angular",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("src", "main.ts"));
    expect(plan.content).toContain(`httpAuthToken: "${KEY}"`);
  });

  it("falls back to AI when the Angular entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "angular",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
  });
});

describe("buildPlan — NestJS", () => {
  it("prepends the headless-session block + env action into src/main.ts", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("src", "main.ts")]: "bootstrap();\n" },
      { gitignore: ".env\n" },
    );
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "nestjs",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.recipe).toBe("nestjs");
    expect(plan.targetPath).toBe(p("src", "main.ts"));
    expect(plan.content).toContain("autoCapture");
    expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
    expect(plan.envAction?.line).toBe(`CRUMBTRAIL_KEY=${KEY}`);
    // BUG-12: Nest scaffolds default to Prettier `singleQuote: true`, so the
    // injected block must use single quotes — never the double-quoted node form.
    expect(plan.content).toContain("import('crumbtrail-node')");
    expect(plan.content).toContain(`endpoint: '${ENDPOINT}'`);
    expect(plan.content).not.toContain('import("crumbtrail-node")');
    expect(plan.content).not.toContain(`endpoint: "${ENDPOINT}"`);
  });

  it("falls back to the backend agent prompt when the entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "nestjs",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain("crumbtrail-node");
  });
});

describe("buildPlan — Node .env handling", () => {
  it("appends CRUMBTRAIL_KEY and warns when .env is not gitignored", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: "const app = express();\n",
      [p(".env")]: "FOO=1\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("server.js"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
    expect(plan.envAction?.line).toBe(`CRUMBTRAIL_KEY=${KEY}`);
    expect(plan.envAction?.gitignoreWarning).toMatch(/gitignore/i);
    expect(plan.warnings.join(" ")).toMatch(/gitignore/i);
  });

  it("emits no gitignore warning when .env is covered", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("server.js")]: "x\n" },
      { gitignore: "node_modules\n.env\n" },
    );
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("server.js"),
      },
      io,
    );
    expect(plan.envAction?.gitignoreWarning).toBeUndefined();
  });

  it("omits the env action when CRUMBTRAIL_KEY is already present", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: "x\n",
      [p(".env")]: "CRUMBTRAIL_KEY=old\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        apiKey: KEY,
        entryFile: p("server.js"),
      },
      io,
    );
    expect(plan.envAction).toBeUndefined();
    expect(plan.warnings.join(" ")).toMatch(/already present/i);
  });
});

describe("buildPlan — otlp guidance (non-JS backends)", () => {
  it("returns a non-mutating otlp-guidance plan with snippet + agent prompt", () => {
    const io = fakeInjectIO({});
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "otlp",
        endpoint: ENDPOINT,
        apiKey: KEY,
        stack: "fastapi",
      },
      io,
    );
    expect(plan.kind).toBe("otlp-guidance");
    expect(plan.targetPath).toBeNull();
    expect(plan.content).toBeNull();
    // OTLP env snippet is filled with the real endpoint/key.
    expect(plan.snippet).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${ENDPOINT}`);
    expect(plan.snippet).toContain(`X-Crumbtrail-Auth=${KEY}`);
    expect(plan.snippet).toContain("crumbtrail.session.id");
    // Agent prompt routes to the no-SDK OTLP variant (no PRESET_PASSIVE).
    expect(plan.agentPrompt).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(KEY);
    expect(plan.agentPrompt).not.toContain("PRESET_PASSIVE");
  });

  it("keys the agent prompt to the DETECTED stack, not the registry placeholder", () => {
    const io = fakeInjectIO({});
    // The registry placeholder for otlp is "django"; a detected go stack must
    // still route via the shared OTLP prompt (both are otlp-variant), so assert
    // the guidance is the no-SDK OTLP path regardless.
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "otlp",
        endpoint: ENDPOINT,
        apiKey: KEY,
        stack: "go",
      },
      io,
    );
    expect(plan.kind).toBe("otlp-guidance");
    expect(plan.agentPrompt).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(plan.agentPrompt).not.toContain("PRESET_PASSIVE");
  });
});
