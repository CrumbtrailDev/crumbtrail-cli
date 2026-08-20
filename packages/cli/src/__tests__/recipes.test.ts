import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildPlan, supportsInstrumentationClient } from "../inject/recipes";
import { fakeInjectIO } from "./helpers";

const CWD = "/proj";
const ENDPOINT = "https://ingest.example.com";
// The installer is hands-off: printed guidance carries this placeholder, never a
// live minted key. Injected code reads the key from an env var, never a literal.
const KEY_PLACEHOLDER = "<your-ingest-key>";
const p = (...parts: string[]) => path.join(CWD, ...parts);

// A snippet/plan-content must never leak a real ingest-key literal. The historic
// key prefixes were `ctkey_` / `bgk_` / `bl_ingest_`; guard against all of them.
function expectNoKeyLiteral(text: string | null | undefined): void {
  expect(text ?? "").not.toMatch(/ctkey_|bgk_|bl_ingest_/);
}

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
  it("creates instrumentation-client.ts for modern Next reading the env key (no literal)", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("instrumentation-client.ts"));
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    // Hands-off: the snippet reads the key from the framework env var, not a
    // baked-in literal.
    expect(plan.content).toContain(
      "httpAuthToken: process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.content).toContain('from "crumbtrail-core"');
    // The wizard prints this var name + "mint in the dashboard".
    expect(plan.keyEnvVar).toBe("NEXT_PUBLIC_CRUMBTRAIL_KEY");
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
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.targetPath).toBe(p("src", "instrumentation-client.ts"));
  });

  // Regression (Alertbase PR #544): the real install created
  // `website/src/instrumentation-client.ts` beside an existing root
  // `instrumentation-client.js` holding Sentry and PostHog. That app keeps its
  // pages under src/, so Next resolves from src/ and the NEW file wins — the
  // customer loses two vendors to gain one. Only `.ts` in one directory was
  // ever checked. Now every loadable extension in both directories is.
  it("wires into an existing root instrumentation-client.js instead of creating a src sibling", () => {
    const existing = [
      'import * as Sentry from "@sentry/nextjs";',
      'import posthog from "posthog-js";',
      "Sentry.init({});",
    ].join("\n");
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "pages")]: "",
      [p("instrumentation-client.js")]: existing,
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "next", endpoint: ENDPOINT, nextVersion: "15.5.12" },
      io,
    );
    // "prepend", not "create": the customer's Sentry and PostHog init survives
    // because we join their file rather than write a competing one.
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("instrumentation-client.js"));
    expect(plan.content).toContain('from "crumbtrail-core"');
    // Nothing is planned at the path the old code would have created.
    expect(plan.targetPath).not.toBe(p("src", "instrumentation-client.ts"));
  });

  it("prefers the instrumentation-client Next actually loads and reports the other as untouched", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "pages")]: "",
      [p("src", "instrumentation-client.tsx")]: "export {};\n",
      [p("instrumentation-client.js")]: "export {};\n",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "next", endpoint: ENDPOINT, nextVersion: "15.5.12" },
      io,
    );
    // src/ holds the pages dir, so Next resolves from src/ and that file wins.
    expect(plan.targetPath).toBe(p("src", "instrumentation-client.tsx"));
    expect(plan.warnings.join(" ")).toContain("instrumentation-client.js");
  });

  it("still creates the file when the app has none", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "app")]: "",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "next", endpoint: ENDPOINT, nextVersion: "15.5.12" },
      io,
    );
    expect(plan.kind).toBe("create");
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
        nextVersion: "14.2.0",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toMatch(/use client|Server Component/i);
    expect(plan.snippet).toContain(`httpEndpoint: "${ENDPOINT}"`);
    // Hands-off: the agent prompt names the env var to set (matching the
    // injected snippet), never a live key.
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expectNoKeyLiteral(plan.agentPrompt);
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
        nextVersion: "^15",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toMatch(/use client|Server Component/i);
  });

  it("hands the AI fallback the app name the injection would have written", () => {
    // The injected snippets all carry `service`; the prompt that stands in for
    // them dropped it, so an install done by pasting this text into a coding
    // agent produced sessions with no app on them.
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        nextVersion: "13.0.0",
        serviceName: "checkout-web",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain('service: "checkout-web",');
  });

  it("falls back to AI when older Next has no layout/_app", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "next",
        endpoint: ENDPOINT,
        nextVersion: "13.0.0",
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expectNoKeyLiteral(plan.agentPrompt);
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
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
    // Nothing to set: an already-wired plan carries no env-var guidance.
    expect(plan.keyEnvVar).toBeUndefined();
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
        nextVersion: "15.4.0",
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });
});

describe("buildPlan — SvelteKit / Nuxt", () => {
  it("creates src/hooks.client.ts for SvelteKit reading the Vite env key (no literal)", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "sveltekit", endpoint: ENDPOINT },
      io,
    );
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("src", "hooks.client.ts"));
    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.keyEnvVar).toBe("VITE_CRUMBTRAIL_KEY");
  });

  it("prepends into an existing hooks.client.ts", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "hooks.client.ts")]: "export const handleError = () => {};\n",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "sveltekit", endpoint: ENDPOINT },
      io,
    );
    expect(plan.kind).toBe("prepend");
  });

  it("creates a Nuxt client plugin wrapped in defineNuxtPlugin reading the Vite env key", () => {
    // No app/ dir (Nuxt 3 default): the plugin lands in the repo-root plugins/.
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan({ cwd: CWD, recipe: "nuxt", endpoint: ENDPOINT }, io);
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("plugins", "crumbtrail.client.ts"));
    expect(plan.content).toContain("defineNuxtPlugin");
    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.keyEnvVar).toBe("VITE_CRUMBTRAIL_KEY");
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
    const plan = buildPlan({ cwd: CWD, recipe: "nuxt", endpoint: ENDPOINT }, io);
    expect(plan.kind).toBe("create");
    expect(plan.targetPath).toBe(p("app", "plugins", "crumbtrail.client.ts"));
    expect(plan.content).toContain("defineNuxtPlugin");
  });
});

describe("buildPlan — Flutter", () => {
  const MAIN = p("lib", "main.dart");
  const SIMPLE_MAIN =
    "import 'package:flutter/material.dart';\n\nvoid main() {\n  runApp(const MyApp());\n}\n";

  it("rewrites main() so capture starts before the first frame", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    // Not a prepend: the start call has to be awaited INSIDE main, before
    // runApp, or the session id from the previous launch is never restored.
    expect(plan.kind).toBe("rewrite");
    expect(plan.targetPath).toBe(MAIN);
    expect(plan.content).toContain("Future<void> main() async {");
    expect(plan.content).toContain("await Crumbtrail.start(const CrumbtrailConfig(");
    expect(plan.content).toContain(`endpoint: '${ENDPOINT}',`);
    expect(plan.content!.indexOf("Crumbtrail.start")).toBeLessThan(
      plan.content!.indexOf("runApp"),
    );
    expectNoKeyLiteral(plan.content);
  });

  it("reads the key at compile time, which is all Dart has", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    expect(plan.content).toContain(
      "ingestKey: String.fromEnvironment('CRUMBTRAIL_KEY'),",
    );
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
    // A released Flutter app has no runtime environment to read, so telling the
    // user to put the key in .env would produce an app that captures nothing.
    expect(plan.warnings.join(" ")).toContain("--dart-define=CRUMBTRAIL_KEY");
  });

  it("marks the key compile-time, so the wizard writes no .env for it", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    // Writing the key into a .env here would mint a live credential into a
    // file the app never reads, and every step printed after it would report
    // success for an app that captures nothing.
    expect(plan.keyIsCompileTime).toBe(true);
  });

  it("names the app, since one key covers the whole project", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "flutter",
        endpoint: ENDPOINT,
        entryFile: MAIN,
        serviceName: "checkout-app",
      },
      io,
    );
    expect(plan.content).toContain("service: 'checkout-app',");
  });

  it("says navigation needs the observer, which injection cannot add", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    // The observer has to be handed to the app's navigator, and the injector
    // cannot edit a widget tree. Silence here means timelines with no screens.
    expect(plan.warnings.join(" ")).toContain("CrumbtrailNavigatorObserver");
  });

  it("hands back DART guidance, never a JS agent prompt, when main is unusual", () => {
    const io = fakeInjectIO({
      [MAIN]: "void main() => runApp(const MyApp());\n",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain("crumbtrail_flutter");
    expect(plan.agentPrompt).toContain("flutter pub add crumbtrail_flutter");
    // The registry stack is a typing placeholder. Emitting the JS prompt here
    // would tell an agent to npm install into a project with no package.json.
    expect(plan.agentPrompt).not.toContain("npm install");
    expect(plan.agentPrompt).not.toContain("crumbtrail-core");
    expectNoKeyLiteral(plan.agentPrompt);
  });

  it("falls back when lib/main.dart could not be resolved", () => {
    const io = fakeInjectIO({});
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: null },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toContain("lib/main.dart");
  });

  it("skips an app already wired, so a re-run does not wire main twice", () => {
    const io = fakeInjectIO({
      [MAIN]:
        "import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';\nvoid main() {}\n",
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });

  it("skips when the pubspec already depends on the SDK", () => {
    // Project-level idempotency has to read the pubspec: a Flutter project has
    // no package.json, so the JS check alone would report "not wired" forever.
    const io = fakeInjectIO({
      [p("pubspec.yaml")]: "dependencies:\n  crumbtrail_flutter: ^0.1.0\n",
      [MAIN]: SIMPLE_MAIN,
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
  });

  it("asks before editing a dirty main.dart, and rewrites when confirmed", () => {
    const io = fakeInjectIO({ [MAIN]: SIMPLE_MAIN }, { dirty: [MAIN] });
    const plan = buildPlan(
      { cwd: CWD, recipe: "flutter", endpoint: ENDPOINT, entryFile: MAIN },
      io,
    );
    expect(plan.kind).toBe("needs-confirm-dirty");
    // Whole-file, not a prepended block — applying this as a prepend would
    // duplicate the file's own contents.
    expect(plan.applyMode).toBe("rewrite");

    const forced = buildPlan(
      {
        cwd: CWD,
        recipe: "flutter",
        endpoint: ENDPOINT,
        entryFile: MAIN,
        options: { force: true },
      },
      io,
    );
    expect(forced.kind).toBe("rewrite");
  });
});

describe("buildPlan — Capacitor", () => {
  it("prepends the async init reading the Vite env key, for an Ionic React app", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.tsx")]: "createRoot(document.body);\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "capacitor",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("createCapacitorCrumbtrailAsync");
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.keyEnvVar).toBe("VITE_CRUMBTRAIL_KEY");
  });

  it("never leaves a floating rejection at the top of the entry file", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.tsx")]: "createRoot(document.body);\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "capacitor",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.content).toContain(".catch(() => {});");
  });

  it("reads environment.ts and reports no env var for an Ionic Angular app", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "platformBrowserDynamic();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "capacitor",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("httpAuthToken: environment.crumbtrailKey");
    // An Angular browser build cannot read a VITE_ var, so reporting one would
    // send the user to configure something with no effect.
    expect(plan.content).not.toContain("import.meta.env");
    expect(plan.keyEnvVar).toBeUndefined();
    expect(plan.warnings.join(" ")).toContain("environment.ts");
  });

  it("tells the user which optional plugins produce which context", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.tsx")]: "createRoot(document.body);\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "capacitor",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    const warnings = plan.warnings.join(" ");
    expect(warnings).toContain("@capacitor/device");
    expect(warnings).toContain("cap sync");
  });

  it("falls back to AI when the Capacitor web entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "capacitor",
        endpoint: ENDPOINT,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain("createCapacitorCrumbtrailAsync");
    expectNoKeyLiteral(plan.agentPrompt);
  });
});

describe("buildPlan — React Native", () => {
  it("prepends the imperative createReactNativeCrumbtrail block reading the Expo env key", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("App.tsx")]: "export default function App() {}\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "react-native",
        endpoint: ENDPOINT,
        entryFile: p("App.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("createReactNativeCrumbtrail");
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain(
      "httpAuthToken: process.env.EXPO_PUBLIC_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.keyEnvVar).toBe("EXPO_PUBLIC_CRUMBTRAIL_KEY");
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
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain("createReactNativeCrumbtrail");
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expectNoKeyLiteral(plan.agentPrompt);
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
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("transportInstance: new TauriTransport()");
    expect(plan.content).toContain('from "crumbtrail-core/tauri"');
    // transportInstance override, NOT the `transport` string-mode field.
    expect(plan.content).not.toMatch(/transport:\s*new TauriTransport/);
    // Tauri routes to the local Rust store — it injects no key, so there is no
    // env var to set.
    expect(plan.keyEnvVar).toBeUndefined();
    expectNoKeyLiteral(plan.content);
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
        entryFile: p("src", "main.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("needs-confirm-dirty");
  });

  it("prepends a dirty target when force is set, reading the Vite env key (no literal)", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("src", "main.tsx")]: "render();\n" },
      { dirty: [p("src", "main.tsx")] },
    );
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.tsx"),
        options: { force: true },
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.keyEnvVar).toBe("VITE_CRUMBTRAIL_KEY");
  });

  it("falls back to AI with a filled snippet when the entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expectNoKeyLiteral(plan.agentPrompt);
  });
});

describe("buildPlan — backend-JS recipes (express/hono/fastify)", () => {
  for (const recipe of ["express", "hono", "fastify"] as const) {
    it(`${recipe}: prepends the headless-session block reading process.env.CRUMBTRAIL_KEY`, () => {
      const io = fakeInjectIO({
        [p("package.json")]: "{}",
        [p("server.js")]: "x\n",
      });
      const plan = buildPlan(
        {
          cwd: CWD,
          recipe,
          endpoint: ENDPOINT,
          entryFile: p("server.js"),
        },
        io,
      );
      expect(plan.kind).toBe("prepend");
      expect(plan.recipe).toBe(recipe);
      // The server snippet reads the key from process.env; the installer writes
      // nothing to .env (hands-off). The wizard names the var via keyEnvVar.
      expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
      expect(plan.content).toContain("autoCapture");
      expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
      expectNoKeyLiteral(plan.content);
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
          entryFile: p("server.js"),
        },
        io,
      );
      expect(plan.kind).toBe("needs-confirm-dirty");
    });

    it(`${recipe}: falls back to AI with the backend agent prompt when the entry is unresolved`, () => {
      const io = fakeInjectIO({ [p("package.json")]: "{}" });
      const plan = buildPlan(
        { cwd: CWD, recipe, endpoint: ENDPOINT, entryFile: null },
        io,
      );
      expect(plan.kind).toBe("fallback-ai");
      expect(plan.snippet).toContain(ENDPOINT);
      expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
      expect(plan.agentPrompt).toContain("crumbtrail-node");
      expectNoKeyLiteral(plan.agentPrompt);
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
      { cwd: CWD, recipe, endpoint: ENDPOINT, entryFile: null },
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

describe("buildPlan — Node recipe", () => {
  it("prepends the headless-session block reading process.env.CRUMBTRAIL_KEY (no literal)", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: "const app = express();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
    expect(plan.content).toContain("autoCapture");
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
    expectNoKeyLiteral(plan.content);
  });

  it("falls back to AI when the Node entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      { cwd: CWD, recipe: "node", endpoint: ENDPOINT, entryFile: null },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain("crumbtrail-node");
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
  });
});

describe("buildPlan — Remix", () => {
  it("prepends the client init reading the Vite env key into the resolved entry.client", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("app", "entry.client.tsx")]: "hydrateRoot();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "remix",
        endpoint: ENDPOINT,
        entryFile: p("app", "entry.client.tsx"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.targetPath).toBe(p("app", "entry.client.tsx"));
    expect(plan.content).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.content).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.content);
    expect(plan.content).toContain('from "crumbtrail-core"');
    expect(plan.keyEnvVar).toBe("VITE_CRUMBTRAIL_KEY");
  });

  it("falls back to AI (never creates) when entry.client is absent", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "remix",
        endpoint: ENDPOINT,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expectNoKeyLiteral(plan.agentPrompt);
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
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.warnings.join(" ")).toContain("npx react-router reveal");
  });
});

describe("buildPlan — Astro", () => {
  it("always falls back to a guided snippet reading the Astro PUBLIC env key", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "astro",
        endpoint: ENDPOINT,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(`httpEndpoint: "${ENDPOINT}"`);
    expect(plan.snippet).toContain(
      "httpAuthToken: import.meta.env.PUBLIC_CRUMBTRAIL_KEY",
    );
    expectNoKeyLiteral(plan.snippet);
    expect(plan.snippet).toContain('from "crumbtrail-core"');
    expect(plan.agentPrompt).toContain(plan.keyEnvVar as string);
    expect(plan.warnings.join(" ")).toMatch(/layout/i);
    expect(plan.keyEnvVar).toBe("PUBLIC_CRUMBTRAIL_KEY");
  });
});

describe("buildPlan — Angular", () => {
  // Angular has no browser-safe env-var mechanism (no import.meta.env /
  // process.env), so there is NO keyRef in the registry. planAngular always hands
  // off with guidance to add the key to environment.ts — never a prepend/create.
  it("always hands off with environment.ts guidance (never prepends)", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "bootstrapApplication(AppComponent);\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "angular",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    // The snippet reads the key from environment.ts, not an env var or literal.
    expect(plan.snippet).toContain("httpAuthToken: environment.crumbtrailKey");
    expectNoKeyLiteral(plan.snippet);
    expect(plan.warnings.join(" ")).toMatch(/environment\.ts/i);
    // No browser-safe env var → no keyEnvVar guidance.
    expect(plan.keyEnvVar).toBeUndefined();
  });

  it("still hands off with guidance when the Angular entry is unresolved", () => {
    const io = fakeInjectIO({ [p("package.json")]: "{}" });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "angular",
        endpoint: ENDPOINT,
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).toContain(ENDPOINT);
    expect(plan.keyEnvVar).toBeUndefined();
  });
});

describe("buildPlan — NestJS", () => {
  it("prepends the headless-session block reading process.env.CRUMBTRAIL_KEY into src/main.ts", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("src", "main.ts")]: "bootstrap();\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "nestjs",
        endpoint: ENDPOINT,
        entryFile: p("src", "main.ts"),
      },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.recipe).toBe("nestjs");
    expect(plan.targetPath).toBe(p("src", "main.ts"));
    expect(plan.content).toContain("autoCapture");
    expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
    expectNoKeyLiteral(plan.content);
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
        entryFile: null,
      },
      io,
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.agentPrompt).toContain("crumbtrail-node");
  });
});

describe("buildPlan — otlp guidance (non-JS backends)", () => {
  it("returns a non-mutating otlp-guidance plan with a placeholder-keyed snippet + prompt", () => {
    const io = fakeInjectIO({});
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "otlp",
        endpoint: ENDPOINT,
        stack: "fastapi",
      },
      io,
    );
    expect(plan.kind).toBe("otlp-guidance");
    expect(plan.targetPath).toBeNull();
    expect(plan.content).toBeNull();
    // OTLP env snippet carries the real endpoint but only the placeholder key
    // (hands-off — no minted key is ever printed).
    expect(plan.snippet).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${ENDPOINT}`);
    expect(plan.snippet).toContain(`X-Crumbtrail-Auth=${KEY_PLACEHOLDER}`);
    expect(plan.snippet).toContain("crumbtrail.session.id");
    expectNoKeyLiteral(plan.snippet);
    // Agent prompt routes to the no-SDK OTLP variant (no PRESET_PASSIVE).
    expect(plan.agentPrompt).toContain(ENDPOINT);
    expect(plan.agentPrompt).toContain(KEY_PLACEHOLDER);
    expect(plan.agentPrompt).not.toContain("PRESET_PASSIVE");
    // otlp injects no key via an env var — it uses OTLP headers instead.
    expect(plan.keyEnvVar).toBeUndefined();
  });

  it("names the app, because a project key names none", () => {
    const io = fakeInjectIO({});
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "otlp",
        endpoint: ENDPOINT,
        stack: "fastapi",
        serviceName: "billing-api",
      },
      io,
    );
    // The receiver resolves an app from service.name when the key names none,
    // and every OTLP SDK sets service.name from OTEL_SERVICE_NAME.
    expect(plan.snippet).toContain("OTEL_SERVICE_NAME=billing-api");
    expect(plan.agentPrompt).toContain("OTEL_SERVICE_NAME=billing-api");

    // With no provisioned name, it asks for one rather than filing under none.
    const unnamed = buildPlan(
      { cwd: CWD, recipe: "otlp", endpoint: ENDPOINT, stack: "fastapi" },
      io,
    );
    expect(unnamed.snippet).toContain("OTEL_SERVICE_NAME=<your-app-name>");
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
        stack: "go",
      },
      io,
    );
    expect(plan.kind).toBe("otlp-guidance");
    expect(plan.agentPrompt).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(plan.agentPrompt).not.toContain("PRESET_PASSIVE");
  });
});

describe("buildPlan — Express middleware wiring", () => {
  const ESM_ENTRY = [
    'import express from "express";',
    "",
    "const app = express();",
    "",
    'app.get("/", (req, res) => res.send("ok"));',
    "",
    "app.listen(3000);",
    "",
  ].join("\n");

  const CJS_ENTRY = [
    'const express = require("express");',
    "const app = express();",
    'app.get("/", (req, res) => res.send("ok"));',
    "app.listen(3000);",
    "",
  ].join("\n");

  it("rewrites an ESM entry: request middleware before routes, error middleware after", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: ESM_ENTRY,
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    expect(plan.kind).toBe("rewrite");
    const content = plan.content ?? "";
    // autoCapture block plus ESM import of the middleware pair.
    expect(content).toContain("autoCapture");
    expect(content).toContain(
      'import { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } from "crumbtrail-node";',
    );
    // Ordering: app creation -> request middleware -> routes -> error middleware -> listen.
    const appIdx = content.indexOf("const app = express()");
    const reqIdx = content.indexOf("app.use(createCrumbtrailExpressMiddleware(");
    const routeIdx = content.indexOf('app.get("/"');
    const errIdx = content.indexOf("app.use(createCrumbtrailExpressErrorMiddleware(");
    const listenIdx = content.indexOf("app.listen(");
    expect(appIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeGreaterThan(appIdx);
    expect(routeIdx).toBeGreaterThan(reqIdx);
    expect(errIdx).toBeGreaterThan(routeIdx);
    expect(listenIdx).toBeGreaterThan(errIdx);
    // Same endpoint/env-key expressions as autoCapture: no key literal.
    expect(content).toContain(`endpoint: "${ENDPOINT}"`);
    expect(content).toContain("authToken: process.env.CRUMBTRAIL_KEY");
    expectNoKeyLiteral(content);
  });

  // Regression (Alertbase PR #544): `job-server` and `user-billing-service` both
  // register a four argument error handler that always responds, immediately
  // above `app.listen`. Anchoring on listen put Crumbtrail's handler BELOW it,
  // where Express never reaches it, so those two services captured no errors.
  const ENTRY_WITH_ERROR_HANDLER = [
    'import express from "express";',
    "",
    "const app = express();",
    "",
    'app.get("/", (req, res) => res.send("ok"));',
    "",
    "app.use((error: any, req: Request, res: Response, next: NextFunction) => {",
    '  res.status(500).json({ error: "boom" });',
    "});",
    "",
    "app.listen(3000);",
    "",
  ].join("\n");

  it("places the error middleware above an existing four argument error handler", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.ts")]: ENTRY_WITH_ERROR_HANDLER,
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.ts") },
      io,
    );
    expect(plan.kind).toBe("rewrite");
    const content = plan.content ?? "";
    const routeIdx = content.indexOf('app.get("/"');
    const ourErrIdx = content.indexOf("app.use(createCrumbtrailExpressErrorMiddleware(");
    const theirErrIdx = content.indexOf("app.use((error: any");
    const listenIdx = content.indexOf("app.listen(");
    // After the routes, but BEFORE the handler that ends the response.
    expect(ourErrIdx).toBeGreaterThan(routeIdx);
    expect(ourErrIdx).toBeLessThan(theirErrIdx);
    expect(theirErrIdx).toBeLessThan(listenIdx);
    expect(plan.warnings.join(" ")).toContain("existing error handler");
  });

  it("handles a function-form error handler with the parameter list split across lines", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: [
        'import express from "express";',
        "const app = express();",
        'app.get("/", (req, res) => res.send("ok"));',
        "app.use(function (",
        "  err,",
        "  req,",
        "  res,",
        "  next",
        ") {",
        "  res.status(500).end();",
        "});",
        "app.listen(3000);",
        "",
      ].join("\n"),
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    const content = plan.content ?? "";
    expect(content.indexOf("app.use(createCrumbtrailExpressErrorMiddleware(")).toBeLessThan(
      content.indexOf("app.use(function ("),
    );
  });

  it("ignores non error middleware and route mounts when picking the anchor", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: [
        'import express from "express";',
        "const app = express();",
        "app.use(express.json());",
        'app.use("/users", userRoutes);',
        "app.use((req, res, next) => next());",
        'app.get("/", (req, res) => res.send("ok"));',
        "app.listen(3000);",
        "",
      ].join("\n"),
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    const content = plan.content ?? "";
    // No four argument handler here, so the listen anchor still applies.
    expect(content.indexOf("app.use(createCrumbtrailExpressErrorMiddleware(")).toBeLessThan(
      content.indexOf("app.listen("),
    );
    expect(content.indexOf("app.use(createCrumbtrailExpressErrorMiddleware(")).toBeGreaterThan(
      content.indexOf('app.get("/"'),
    );
  });

  it("rewrites a CJS entry with a require of the middleware pair", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: CJS_ENTRY,
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    expect(plan.kind).toBe("rewrite");
    expect(plan.content).toContain(
      'const { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } = require("crumbtrail-node");',
    );
    expect(plan.content).toContain("app.use(createCrumbtrailExpressMiddleware(");
    expect(plan.content).toContain("app.use(createCrumbtrailExpressErrorMiddleware(");
  });

  it("needs-confirm-dirty with applyMode rewrite when the entry is dirty", () => {
    const io = fakeInjectIO(
      { [p("package.json")]: "{}", [p("server.js")]: ESM_ENTRY },
      { dirty: [p("server.js")] },
    );
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    expect(plan.kind).toBe("needs-confirm-dirty");
    expect(plan.applyMode).toBe("rewrite");
    expect(plan.content).toContain("app.use(createCrumbtrailExpressMiddleware(");
  });

  it("falls back to prepend + TODO instructions when anchors are missing", () => {
    // Has an express import but no `const app = express()` / listen anchors.
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: 'import express from "express";\nconst app = buildApp();\n',
    });
    const plan = buildPlan(
      { cwd: CWD, recipe: "express", endpoint: ENDPOINT, entryFile: p("server.js") },
      io,
    );
    expect(plan.kind).toBe("prepend");
    expect(plan.content).toContain("autoCapture");
    expect(plan.content).toContain("TODO(crumbtrail)");
    expect(plan.content).toContain("createCrumbtrailExpressMiddleware");
    expect(plan.content).toContain("createCrumbtrailExpressErrorMiddleware");
    // The wizard surfaces the same guidance.
    expect(plan.warnings.join(" ")).toContain("createCrumbtrailExpressMiddleware");
  });

  it("does not wire middleware for non express backend recipes", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: ESM_ENTRY,
    });
    for (const recipe of ["fastify", "hono", "node"] as const) {
      const plan = buildPlan(
        { cwd: CWD, recipe, endpoint: ENDPOINT, entryFile: p("server.js") },
        io,
      );
      expect(plan.kind).toBe("prepend");
      expect(plan.content).not.toContain("app.use(createCrumbtrailExpress");
    }
  });
});

// One key per project means the injected code has to say which app it is.
//
// The key used to carry the app, and a repository of six apps meant six
// secrets. Now one CRUMBTRAIL_KEY covers the project and the init call names
// the app. The name has to reach the emitted code, not just the printed
// guidance: a name the customer sees and the code never sends attributes
// nothing.
describe("buildPlan — the app names itself", () => {
  it("bakes the app's name into a backend init call", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: "x\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "job-engine",
      },
      io,
    );
    // Same variable every app in the repository reads, because there is now
    // only one key to read.
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
    expect(plan.content).toContain("process.env.CRUMBTRAIL_KEY");
    expect(plan.content).toContain('service: "job-engine"');
    expectNoKeyLiteral(plan.content);
  });

  it("bakes it into a browser init call too", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({ dependencies: { vite: "^5" } }),
      [p("src/main.ts")]: "x\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "vite-spa",
        endpoint: ENDPOINT,
        entryFile: p("src/main.ts"),
        serviceName: "website",
      },
      io,
    );
    expect(plan.content).toContain('service: "website"');
  });

  it("emits no service field when the app was not named", () => {
    const io = fakeInjectIO({
      [p("package.json")]: "{}",
      [p("server.js")]: "x\n",
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
      },
      io,
    );
    expect(plan.keyEnvVar).toBe("CRUMBTRAIL_KEY");
    expect(plan.content).not.toContain("service:");
  });
});
