// Pure injection plan-builders. Each recipe reads (never writes) via InjectIO and
// returns a Plan describing exactly what should happen. The executor (executor.ts)
// is the only module that mutates the filesystem.
//
// Pre-flight order, before ANY write is planned:
//   1. idempotency  — project/target already references crumbtrail-core/-node -> skip
//   2. cleanliness  — git status on the target; dirty -> needs-confirm (unless force)
//   3. sanity       — target is a readable module (prepend) or safe-to-create
// Any failure or ambiguity -> fallback-ai plan carrying the filled snippet +
// buildAgentPrompt(...) from ../install.

import path from "node:path";
import { buildAgentPrompt, buildOtlpSnippets } from "../install/index.js";
import type { Stack } from "crumbtrail-core";
import type { Recipe } from "../detect";
import { RECIPE_REGISTRY, type KeyRef } from "../recipe-registry";
import { defaultInjectIO, type InjectIO } from "./io";
import type { Plan } from "./types";
import {
  detectExpressModuleStyle,
  prependIntoSource,
  referencesCrumbtrail,
  wireExpressMiddleware,
  wireFlutterMain,
  withTrailingNewline,
} from "./text";
import {
  capacitorInitSnippet,
  clientInitSnippet,
  expressErrorMiddlewareSnippet,
  expressEnvPreloadSnippet,
  expressManualWiringSnippet,
  expressMiddlewareImportSnippet,
  expressRequestMiddlewareSnippet,
  FLUTTER_IMPORT_LINE,
  flutterInitLines,
  flutterInitSnippet,
  nestInitSnippet,
  nodeInitSnippet,
  nuxtPluginSnippet,
  reactNativeInitSnippet,
  tauriInitSnippet,
} from "./snippets";

/**
 * Placeholder used in printed guidance (fallback-ai + OTLP) now that the
 * installer never mints a key. The user replaces it with the key they mint in
 * the dashboard. Never written to a file — only shown in copyable instructions.
 */
const KEY_PLACEHOLDER = "<your-ingest-key>";

/**
 * How this app reads its key: the recipe's own reference, unchanged. One ingest
 * key covers the whole project, so every app in a repository reads the same
 * variable for its framework and the init call carries the app's name instead.
 *
 * `capacitor` is the one recipe whose key mechanism is not fixed by the recipe
 * alone, because Ionic ships both a Vite flavour and an Angular one. An Angular
 * browser build exposes no env var at all, so it gets NO key ref — the same
 * answer the `angular` recipe gives, reached the same way. This is the single
 * decision point: `buildPlan` reads `envVar` from here and the snippet reads
 * `expr` from here, so the two can never disagree.
 */
function keyRefFor(input: BuildPlanInput): KeyRef | undefined {
  if (
    input.recipe === "capacitor" &&
    input.entryFile &&
    isAngularHostedCapacitor(input.entryFile)
  ) {
    return undefined;
  }
  return RECIPE_REGISTRY[input.recipe].keyRef;
}

/** The code expression an injected snippet uses to read the key. */
function keyExprFor(input: BuildPlanInput): string | undefined {
  return keyRefFor(input)?.expr;
}

export interface BuildPlanOptions {
  /** Prepend into a dirty (uncommitted) target instead of asking to confirm. */
  force?: boolean;
}

export interface BuildPlanInput {
  cwd: string;
  recipe: Recipe;
  endpoint: string;
  /** Absolute entry path for vite-spa / node (from detection). */
  entryFile?: string | null;
  /** Raw `next` version range from detection (drives new-file vs legacy-prepend). */
  nextVersion?: string | null;
  /**
   * The detected non-JS backend Stack for the `otlp` recipe (from
   * `DetectResult.otlpStack`). Drives the guidance agent prompt; ignored for
   * every other recipe.
   */
  stack?: Stack;
  /**
   * Which app in the project this is, baked into the injected init call so a
   * session says where it came from. One key covers the whole project, so
   * without this a repository of six apps is six anonymous senders. Callers
   * that wire a repository pass the app's name; a single app run from its own
   * root can pass nothing and stay unlabelled.
   */
  serviceName?: string | null;
  options?: BuildPlanOptions;
}

// --- shared plan constructors ------------------------------------------------

function skipPlan(input: BuildPlanInput, warnings: string[] = []): Plan {
  return {
    recipe: input.recipe,
    kind: "skip-already-wired",
    targetPath: null,
    content: null,
    warnings: [
      ...warnings,
      "Project already references Crumbtrail — nothing to inject.",
    ],
  };
}

function fallbackPlan(
  input: BuildPlanInput,
  snippet: string,
  warnings: string[],
): Plan {
  return {
    recipe: input.recipe,
    kind: "fallback-ai",
    targetPath: null,
    content: null,
    snippet,
    // Hands-off: the prompt reads the key from env / the dashboard, never a
    // baked-in literal (KEY_PLACEHOLDER stands in for the user's own key). Pass
    // the recipe's exact keyRef so the prompt names the same env var the injected
    // snippet reads (e.g. Astro's PUBLIC_, Expo's EXPO_PUBLIC_) — the coarse Stack
    // alone can't distinguish those.
    agentPrompt: buildAgentPrompt(
      RECIPE_REGISTRY[input.recipe].stack,
      {
        endpoint: input.endpoint,
        apiKey: KEY_PLACEHOLDER,
      },
      { keyEnv: keyRefFor(input), serviceName: input.serviceName },
    ),
    warnings,
  };
}

function createPlan(
  input: BuildPlanInput,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  return {
    recipe: input.recipe,
    kind: "create",
    targetPath: target,
    content: withTrailingNewline(block),
    warnings,
  };
}

/**
 * Pre-flight an existing-file prepend: idempotency -> cleanliness -> sanity.
 * Falls back to the AI plan when the file cannot be read; asks to confirm when
 * dirty (unless force). Returns null when the caller should skip (already wired).
 */
function prependWithPreflight(
  input: BuildPlanInput,
  io: InjectIO,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  const existing = io.readFile(target);
  if (existing == null) {
    // Sanity: we thought this file existed but can't read it — hand off.
    return fallbackPlan(input, block, [
      ...warnings,
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  if (referencesCrumbtrail(existing)) {
    return skipPlan(input, warnings);
  }
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: block,
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before prepending.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "prepend",
    targetPath: target,
    content: block,
    warnings,
  };
}

// --- idempotency (project-level) --------------------------------------------

/**
 * The EXACT installed `next` version from `node_modules/next/package.json`, or
 * null when next is not installed / unreadable. Preferred over the declared
 * range because a range like `^15` can resolve to either a legacy 15.2 install
 * or a modern 15.4 one — and the instrumentation-client gate must reflect what
 * will actually run, not what was requested.
 */
function installedNextVersion(cwd: string, io: InjectIO): string | null {
  const text = io.readFile(
    path.join(cwd, "node_modules", "next", "package.json"),
  );
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** True when this package.json declares `name` as a dependency of any kind. */
function dependsOn(cwd: string, io: InjectIO, name: string): boolean {
  const text = io.readFile(path.join(cwd, "package.json"));
  if (text == null) return false;
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return (
      name in
      { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    );
  } catch {
    return false;
  }
}

/**
 * Every npm package whose presence means this app is already wired. The mobile
 * SDKs are on the list because they are what a React Native / Capacitor install
 * actually adds: leaving them off let a re-run mint a second service and a
 * second ingest key for an app that was already reporting.
 */
const CRUMBTRAIL_SDK_PACKAGES = [
  "crumbtrail-core",
  "crumbtrail-node",
  "crumbtrail-react-native",
  "crumbtrail-capacitor",
] as const;

/**
 * The installed `nuxt` MAJOR from `node_modules/nuxt/package.json`, or null when
 * nuxt is not installed / unreadable. Read from what will actually run rather
 * than the declared range, for the same reason `installedNextVersion` is: a
 * range like `^3` says nothing about which srcDir layout the resolved install
 * scans.
 */
function installedNuxtMajor(cwd: string, io: InjectIO): number | null {
  const text = io.readFile(
    path.join(cwd, "node_modules", "nuxt", "package.json"),
  );
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text) as { version?: string };
    const major = Number.parseInt(String(pkg.version ?? "").trim(), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/**
 * True when this package already depends on a Crumbtrail SDK. Load-bearing for
 * the batch installer, which must decide whether to provision a service BEFORE
 * it builds a plan — `buildPlan` uses this to self-cancel into
 * `skip-already-wired`, so a re-run must not mint a second key for a service
 * that is going to be skipped anyway.
 */
export function projectAlreadyWired(cwd: string, io: InjectIO): boolean {
  // A Flutter project has no package.json at all, so the JS check below would
  // report "not wired" forever and a re-run would wire main.dart twice.
  const pubspec = io.readFile(path.join(cwd, "pubspec.yaml"));
  if (pubspec != null && /^\s*crumbtrail_flutter\s*:/m.test(pubspec)) {
    return true;
  }

  const text = io.readFile(path.join(cwd, "package.json"));
  if (text == null) return false;
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return CRUMBTRAIL_SDK_PACKAGES.some(
      (name) => name in deps && sdkPackageInstalled(cwd, io, name),
    );
  } catch {
    return false;
  }
}

/**
 * True when `name` resolves from `cwd` — the dependency is declared AND on disk.
 *
 * A declaration alone is not wiring. A repo can carry a stale range for an SDK
 * nobody ever installed, and reading that as "already wired" skipped the app
 * entirely: the wizard reported the service set up, injection never ran, the
 * install never ran, and the app then failed to start on an import of a package
 * that was not there. Walks up like node resolution so a hoisted monorepo
 * install (root `node_modules`) counts for a nested package.
 */
function sdkPackageInstalled(
  cwd: string,
  io: InjectIO,
  name: string,
): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (io.exists(path.join(dir, "node_modules", name, "package.json"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// --- next version handling ---------------------------------------------------

/**
 * `instrumentation-client.ts` is auto-loaded from Next 15.3+. Parse the leading
 * numeric range; treat non-numeric ranges ("latest", "canary", workspace:) as
 * new-enough.
 */
export function supportsInstrumentationClient(
  version: string | null | undefined,
): boolean {
  if (!version) return true;
  const m = version.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return true; // "latest" / "canary" / "workspace:*" -> assume current
  const major = Number(m[1]);
  const minor = m[2] ? Number(m[2]) : 0;
  if (major > 15) return true;
  if (major < 15) return false;
  return minor >= 3;
}

// --- per-recipe builders -----------------------------------------------------

function firstExistingDir(io: InjectIO, ...dirs: string[]): string | null {
  return dirs.find((d) => io.exists(d)) ?? null;
}

/**
 * Every extension Next will auto-load an instrumentation-client under. Checking
 * only `.ts` is how a real install (Alertbase PR #544) created
 * `website/src/instrumentation-client.ts` next to an existing root
 * `instrumentation-client.js` carrying Sentry and PostHog. That app keeps its
 * pages in `src/`, so Next resolves from `src/` and the NEW file wins: the
 * customer would have silently lost two vendors to gain one.
 */
const INSTRUMENTATION_CLIENT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

export interface InstrumentationClientLookup {
  /** The file Next will actually load, or null when there is none. */
  loaded: string | null;
  /**
   * Every other instrumentation-client on disk. Next ignores these, so we must
   * not edit them and the caller reports them as untouched.
   */
  shadowed: string[];
}

/**
 * Find the instrumentation-client Next will load.
 *
 * Next accepts the file at the project root or under `src/`, and resolves it
 * from whichever directory holds `app/` or `pages/`. `baseDir` is that
 * directory, so a file there wins over one in the other candidate directory.
 * Callers must wire into `loaded` rather than creating a sibling: a second file
 * does not merge with the first, it replaces it.
 */
export function findInstrumentationClient(
  io: InjectIO,
  cwd: string,
  baseDir: string,
): InstrumentationClientLookup {
  const otherDir = baseDir === cwd ? path.join(cwd, "src") : cwd;
  const found: string[] = [];
  for (const dir of [baseDir, otherDir]) {
    for (const ext of INSTRUMENTATION_CLIENT_EXTENSIONS) {
      const candidate = path.join(dir, `instrumentation-client${ext}`);
      if (io.exists(candidate)) found.push(candidate);
    }
  }
  return { loaded: found[0] ?? null, shadowed: found.slice(1) };
}

function planNext(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  // Prefer `src/` when the app uses a src directory.
  const usesSrc =
    io.exists(path.join(cwd, "src", "app")) ||
    io.exists(path.join(cwd, "src", "pages"));
  const baseDir = usesSrc ? path.join(cwd, "src") : cwd;

  // Gate on the INSTALLED next version when available (a declared range like
  // `^15` can resolve to a legacy or a modern install); fall back to the
  // declared range from detection.
  const effectiveVersion = installedNextVersion(cwd, io) ?? input.nextVersion;

  if (supportsInstrumentationClient(effectiveVersion)) {
    const { loaded, shadowed } = findInstrumentationClient(io, cwd, baseDir);
    if (loaded) {
      const existing = io.readFile(loaded);
      if (existing && referencesCrumbtrail(existing)) return skipPlan(input);
      // A user-owned instrumentation-client already exists — prepend into it,
      // whatever its extension and whichever of the two directories it sits in.
      // Creating a sibling would replace it rather than join it.
      return prependWithPreflight(
        input,
        io,
        loaded,
        block,
        shadowed.length
          ? [
              `Wired into ${path.relative(cwd, loaded)}, the instrumentation client Next loads. Left untouched because Next ignores them: ${shadowed
                .map((p) => path.relative(cwd, p))
                .join(", ")}.`,
            ]
          : undefined,
      );
    }
    return createPlan(
      input,
      path.join(baseDir, "instrumentation-client.ts"),
      block,
    );
  }

  // Older Next (<15.3): instrumentation-client.ts is NOT auto-loaded, so the
  // client init must land in a module that actually executes in the browser.
  const pagesApp =
    firstExistingDir(
      io,
      path.join(baseDir, "pages", "_app.tsx"),
      path.join(baseDir, "pages", "_app.jsx"),
    ) ?? null;
  if (pagesApp) {
    // (a) Pages Router: _app is a client-executed root — safe to prepend.
    return prependWithPreflight(input, io, pagesApp, block, [
      "Older Next.js — prepending into pages/_app; move to instrumentation-client.ts after upgrading to 15.3+.",
    ]);
  }

  const appLayout =
    firstExistingDir(
      io,
      path.join(baseDir, "app", "layout.tsx"),
      path.join(baseDir, "app", "layout.jsx"),
    ) ?? null;
  if (appLayout) {
    // (b) App Router only, legacy Next: the root layout is a Server Component
    // that never ships to the browser, so prepending client init there captures
    // nothing. Hand off with a concrete path forward instead.
    return fallbackPlan(input, block, [
      'Next <15.3 with only an app-router root layout: client init can\'t be prepended into app/layout (a Server Component that never ships to the browser). Add the snippet to a "use client" module imported by the root layout, or upgrade to Next 15.3+ for the auto-loaded instrumentation-client.ts.',
    ]);
  }

  // (c) Neither a pages/_app nor an app/layout was found.
  return fallbackPlan(input, block, [
    "Older Next.js detected but no app/layout or pages/_app file was found.",
  ]);
}

function planSvelteKit(input: BuildPlanInput, io: InjectIO): Plan {
  const target = path.join(input.cwd, "src", "hooks.client.ts");
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  if (io.exists(target)) {
    return prependWithPreflight(input, io, target, block);
  }
  return createPlan(input, target, block);
}

function planNuxt(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  // Nuxt 4's default srcDir is app/, so plugins are scanned from app/plugins/;
  // Nuxt 3 scans plugins/ from the project root. Getting this wrong is a silent
  // zero-capture in either direction — neither version loads the other's path.
  //
  // The installed major decides it. A bare `app/` existence probe does not: Nuxt
  // 3 also recognises a root-level app/ directory (app/router.options.ts), so
  // such a project was misread as Nuxt 4 and got a plugin Nuxt 3 never scans.
  // The probe stays as the fallback for when the version cannot be read (nuxt
  // not installed yet), where an app/ directory is still the best signal there
  // is.
  const major = installedNuxtMajor(cwd, io);
  const usesAppDir =
    major != null ? major >= 4 : io.exists(path.join(cwd, "app"));
  const baseDir = usesAppDir ? path.join(cwd, "app") : cwd;
  const target = path.join(baseDir, "plugins", "crumbtrail.client.ts");
  const block = nuxtPluginSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  if (io.exists(target)) {
    const existing = io.readFile(target);
    if (existing && referencesCrumbtrail(existing)) return skipPlan(input);
    // Don't clobber an existing user plugin of the same name — hand off.
    return fallbackPlan(input, block, [
      `${target} already exists and isn't Crumbtrail's — wire it manually.`,
    ]);
  }
  return createPlan(input, target, block);
}

function planVite(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Vite entry from index.html — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Shared backend-JS plan builder. Hono, Fastify, Nest, and the generic Node
 * recipe inject (Express has its own builder, planExpress, which also wires the
 * request/error middleware pair) the same self-contained `autoCapture` block (the only
 * prepend-safe server snippet — no `app` handle is available at the top of a
 * file). The block reads the key from process.env.CRUMBTRAIL_KEY, which the user
 * sets themselves (hands-off — the installer writes no key). Framework-specific
 * middleware wiring is left to `buildAgentPrompt`, which reads the registry stack.
 *
 * The one snippet divergence is Nest: its scaffold ships a `.prettierrc` with
 * `singleQuote: true`, so it gets the single-quoted `nestInitSnippet` to avoid
 * cosmetic diff/lint noise. Every other backend-JS recipe keeps the
 * double-quoted `nodeInitSnippet` (Prettier's own default).
 */
function planNode(input: BuildPlanInput, io: InjectIO): Plan {
  const keyExpr = keyExprFor(input)!;
  const block =
    input.recipe === "nestjs"
      ? nestInitSnippet(input.endpoint, keyExpr, input.serviceName)
      : nodeInitSnippet(input.endpoint, keyExpr, input.serviceName);

  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Express. Injects the same autoCapture block as the other backend-JS recipes,
 * AND wires the request + error middleware so backends emit backend.req.* spans
 * (autoCapture alone captures crashes and console.error only — with no request
 * middleware, frontend to backend linkage stays empty forever).
 *
 * When the entry matches the common shape (an `express` import, a
 * `const app = express()` line, an `app.listen(...)` line), the file is
 * rewritten with the middleware registered in the right positions: request
 * middleware right after app creation (before routes), error middleware just
 * above listen (after routes). When any anchor is missing we fall back to the
 * prepend path with a TODO block carrying exact copy and paste lines, and the
 * wizard prints the same instructions.
 */
function planExpress(input: BuildPlanInput, io: InjectIO): Plan {
  const { endpoint } = input;
  const keyRef = keyRefFor(input)!;
  const keyExpr = keyRef.expr;
  const keyEnvVar = keyRef.envVar;
  const block = nodeInitSnippet(endpoint, keyExpr, input.serviceName);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  const target = input.entryFile;
  const existing = io.readFile(target);
  if (existing == null) {
    return fallbackPlan(input, block, [
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  if (referencesCrumbtrail(existing)) {
    return skipPlan(input);
  }

  const style = detectExpressModuleStyle(existing);
  const wired = style
    ? wireExpressMiddleware(
        existing,
        (appVar) => expressRequestMiddlewareSnippet(appVar, endpoint, keyExpr),
        (appVar) => expressErrorMiddlewareSnippet(appVar, endpoint, keyExpr),
      )
    : null;

  if (wired == null) {
    // Anchors not found: prepend autoCapture plus a TODO block with exact copy
    // and paste instructions, and surface the same guidance in wizard output.
    const combined = `${block}\n\n${expressEnvPreloadSnippet(keyEnvVar)}\n\n${expressManualWiringSnippet(endpoint, keyExpr)}`;
    return prependWithPreflight(input, io, target, combined, [
      "Express request middleware was NOT wired automatically (no `const app = express()` / `app.listen(...)` anchors found). Follow the TODO block added at the top of the entry: register createCrumbtrailExpressMiddleware before your routes and createCrumbtrailExpressErrorMiddleware after them, or backend request spans stay empty.",
    ]);
  }

  // Full rewrite: middleware wired around the routes, plus the autoCapture block
  // and the middleware import prepended after any shebang/directive prologue.
  const content = prependIntoSource(
    wired.text,
    `${block}\n\n${expressEnvPreloadSnippet(keyEnvVar)}\n\n${expressMiddlewareImportSnippet(style!)}`,
  );
  const warnings = [
    wired.errorAnchor === "existing-error-handler"
      ? "Wired Express request middleware (before routes) and error middleware above the app's existing error handler, so it is reached before that handler ends the response."
      : "Wired Express request middleware (before routes) and error middleware (after routes) for backend request capture.",
  ];
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content,
      applyMode: "rewrite",
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content,
    warnings,
  };
}

/**
 * Remix / React Router v7. Prepends the client init into the resolved
 * `app/entry.client.*`. When that entry is absent we FALL BACK rather than
 * create one — a bare init-only entry.client would omit hydrateRoot /
 * <RemixBrowser> and break hydration (a deliberate divergence from planNext).
 */
function planRemix(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve app/entry.client.* — on a React Router 7 default template the client entry is hidden, so run `npx react-router reveal` to unhide app/entry.client.tsx (and entry.server.tsx), then re-run the wizard. Otherwise add the snippet to your Remix client entry manually (do not let the CLI create it; it would omit hydrateRoot).",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Astro. There is no single deterministic client entry, so this recipe always
 * hands off the filled snippet + agent prompt as a guided path — the user drops
 * it into a client-side `<script>` in a shared layout (`.astro`). Honest
 * guidance, not an apology.
 */
function planAstro(input: BuildPlanInput, _io: InjectIO): Plan {
  const block = clientInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
  );
  return fallbackPlan(input, block, [
    "Astro has no single client entry — add this snippet inside a client-side <script> in a shared layout (e.g. src/layouts/*.astro) so it runs on every page.",
  ]);
}

/**
 * Angular. Mirrors planVite: prepend the client init above Angular's
 * `bootstrapApplication`/`platformBrowserDynamic` call in the resolved
 * `src/main.ts`; fall back when the entry is unresolved.
 */
function planAngular(input: BuildPlanInput, _io: InjectIO): Plan {
  // A standard Angular browser build exposes neither import.meta.env nor
  // process.env, so there is no hands-off env var to read (hence no keyRef in the
  // registry). Emit guidance to add the key to environment.ts and wire it by hand
  // rather than injecting code that would reference an undefined variable.
  const block = clientInitSnippet(
    input.endpoint,
    "environment.crumbtrailKey",
    input.serviceName,
  );
  return fallbackPlan(input, block, [
    "Angular has no browser-safe env-var mechanism — add `crumbtrailKey: '<your-ingest-key>'` to src/environments/environment.ts (get your key from the dashboard), import `environment`, and prepend the snippet above bootstrapApplication in src/main.ts.",
  ]);
}

/**
 * The two web hosts a Capacitor app can be wired through, and the only thing
 * that differs between them: how browser code is allowed to read an env var.
 */
const CAPACITOR_ANGULAR_KEY_EXPR = "environment.crumbtrailKey";

/**
 * Ionic ships both a Vite flavour (React/Vue/vanilla) and an Angular one, and
 * they disagree on exactly one point. A Vite build substitutes
 * `import.meta.env.VITE_*` at bundle time; a standard Angular browser build
 * exposes neither `import.meta.env` nor `process.env`, so injecting the Vite
 * expression there would emit code that references an undefined value and fail
 * at runtime with no useful error.
 *
 * The entry file is the discriminator, and it is unambiguous: `resolveViteEntry`
 * only resolves through a root `index.html`, while `resolveAngularEntry` only
 * ever returns `src/main.ts`.
 */
function isAngularHostedCapacitor(entryFile: string): boolean {
  return path.basename(entryFile) === "main.ts";
}

/**
 * Capacitor / Ionic.
 *
 * Injects into the web entry, exactly like the Vite and Angular recipes — the
 * app IS a web build. The difference is which init it calls:
 * `createCapacitorCrumbtrailAsync` runs the same `Crumbtrail.init` underneath
 * and then attaches the native collectors, so the wired app gets both halves
 * rather than web capture with a phone-shaped blind spot.
 */
function planCapacitor(input: BuildPlanInput, io: InjectIO): Plan {
  const entryFile = input.entryFile;
  const angularHosted = entryFile ? isAngularHostedCapacitor(entryFile) : false;
  const keyExpr = angularHosted
    ? CAPACITOR_ANGULAR_KEY_EXPR
    : keyExprFor(input)!;
  const block = capacitorInitSnippet(
    input.endpoint,
    keyExpr,
    input.serviceName,
  );

  // Native plugins are optional peers, so the SDK degrades rather than failing
  // without them — but a user who installs none gets web capture and no phone
  // context at all, which is the outcome they came here to avoid. Say so.
  const warnings = [
    "Capacitor context comes from optional plugins — install the ones you want captured: @capacitor/app (foreground/background, deep links), @capacitor/device (model, OS, WebView version), @capacitor/network (connectivity), @capacitor/preferences (session continuity across cold starts).",
    "Run `npx cap sync` after installing, or the native projects will not pick the plugins up.",
  ];
  if (angularHosted) {
    warnings.push(
      "Angular has no browser-safe env-var mechanism — add `crumbtrailKey: '<your-ingest-key>'` to src/environments/environment.ts (get your key from the dashboard) and import `environment` in src/main.ts.",
    );
  }

  if (!entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Capacitor web entry — wire it manually.",
      ...warnings,
    ]);
  }

  return prependWithPreflight(input, io, entryFile, block, warnings);
}

/**
 * Flutter.
 *
 * The only recipe that edits inside a function rather than prepending. Capture
 * has to start before `runApp` and has to be awaited, so `wireFlutterMain`
 * transforms `main`: import added, `main` made async, the start call inserted as
 * its first statement. When the file is not in a shape that can be transformed
 * with certainty, this hands back Dart guidance rather than a near-miss edit —
 * a wrong guess here either fails to compile or, worse, compiles and captures
 * nothing.
 *
 * It does NOT use `fallbackPlan`. That builds a JavaScript agent prompt from the
 * registry stack, which for a Dart app would instruct an agent to install npm
 * packages into a project that has no package.json.
 */
function planFlutter(input: BuildPlanInput, io: InjectIO): Plan {
  const keyExpr = keyExprFor(input)!;
  const snippet = flutterInitSnippet(
    input.endpoint,
    keyExpr,
    input.serviceName,
  );
  // The key is compile-time in Dart, so it is supplied at build rather than
  // read from a .env the app can see at runtime. Say so once, everywhere.
  const buildNote =
    "Flutter reads the key at build time — pass it with `--dart-define=CRUMBTRAIL_KEY=<your-ingest-key>` on `flutter run` and `flutter build` (get your key from the dashboard).";

  const flutterFallback = (warnings: string[]): Plan => ({
    recipe: input.recipe,
    kind: "fallback-ai",
    targetPath: null,
    content: null,
    snippet,
    agentPrompt: [
      "Wire the Crumbtrail Flutter SDK into this app.",
      "",
      "1. Run `flutter pub add crumbtrail_flutter`.",
      "2. In lib/main.dart, make `main` async and await `Crumbtrail.start` before `runApp`:",
      "",
      snippet,
      "",
      "3. Add `CrumbtrailNavigatorObserver()` to the app's navigatorObservers (or the router's observers) so screen changes are captured.",
      `4. ${buildNote}`,
    ].join("\n"),
    warnings,
  });

  const target = input.entryFile;
  if (!target) {
    return flutterFallback([
      "Could not resolve lib/main.dart — wire it manually.",
      buildNote,
    ]);
  }

  const existing = io.readFile(target);
  if (existing == null) {
    return flutterFallback([
      `Could not read ${target}; wire it manually.`,
      buildNote,
    ]);
  }
  if (referencesCrumbtrail(existing)) {
    return skipPlan(input);
  }

  const wired = wireFlutterMain(
    existing,
    FLUTTER_IMPORT_LINE,
    flutterInitLines(input.endpoint, keyExpr, input.serviceName),
  );
  if (wired == null) {
    return flutterFallback([
      `Could not find a single \`main()\` to wire in ${target} (an arrow-bodied main, or more than one, is not transformed automatically).`,
      buildNote,
    ]);
  }

  const warnings = [
    buildNote,
    // Errors and lifecycle are installed by start(); navigation is not, because
    // the observer has to be handed to the app's navigator and the injector
    // cannot edit a widget tree. Without it a timeline has no screen context.
    "Add `CrumbtrailNavigatorObserver()` to your MaterialApp's `navigatorObservers` (or your router's `observers`) to capture screen changes.",
  ];

  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: wired,
      applyMode: "rewrite",
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing.`,
      ],
    };
  }

  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content: wired,
    warnings,
  };
}

function planReactNative(input: BuildPlanInput, io: InjectIO): Plan {
  // Session continuity needs a store, and on React Native that is AsyncStorage.
  // Only wire it when the app already has it: Metro resolves every import at
  // bundle time, so emitting the import for a package that is not installed
  // would trade a lost session id for an app that does not build.
  const hasAsyncStorage = dependsOn(
    input.cwd,
    io,
    "@react-native-async-storage/async-storage",
  );
  const block = reactNativeInitSnippet(
    input.endpoint,
    keyExprFor(input)!,
    input.serviceName,
    hasAsyncStorage,
  );
  const warnings = hasAsyncStorage
    ? []
    : [
        "No @react-native-async-storage/async-storage in this app, so Crumbtrail wired capture without session continuity: every cold start opens a new session, and an intermittent bug never accumulates into one signature. Install it (`npx expo install @react-native-async-storage/async-storage`) and re-run `npx crumbtrail` to wire the store in.",
      ];
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the React Native entry (App/_layout/index) — wire it manually.",
      ...warnings,
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block, warnings);
}

/**
 * Two Rust-side steps the CLI can't perform (JS injection only): without them
 * the wired JS transport invokes a plugin that isn't registered, so capture
 * silently does nothing. Sourced from packages/tauri/README.md steps 1-2 —
 * kept short, pointing at the README for the exact snippets.
 */
const TAURI_RUST_WARNINGS = [
  "Tauri also needs a Rust step the CLI can't do: register the plugin in src-tauri — add `tauri-plugin-crumbtrail` to Cargo.toml and `.plugin(tauri_plugin_crumbtrail::init())` in lib.rs (packages/tauri/README.md, step 1).",
  "Grant the plugin permission: add `crumbtrail:default` to src-tauri/capabilities/default.json, or every Crumbtrail invoke fails (packages/tauri/README.md, step 2).",
];

function planTauri(input: BuildPlanInput, io: InjectIO): Plan {
  // The Tauri transport routes to the local Rust store, so the block needs no
  // endpoint/apiKey — but they still thread through fallbackPlan's agent prompt.
  const block = tauriInitSnippet();
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Tauri frontend entry from index.html — wire it manually.",
      ...TAURI_RUST_WARNINGS,
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block, [
    ...TAURI_RUST_WARNINGS,
  ]);
}

/**
 * OTLP guidance path (non-JS backends). This recipe NEVER mutates the
 * filesystem: it returns a guidance-only plan (`targetPath`/`content` null)
 * carrying the OTLP setup snippet + the no-SDK agent prompt, keyed to the
 * DETECTED backend Stack (input.stack), not the registry placeholder. An
 * intentional, honest path — not the fallback-ai apology.
 */
function planOtlp(input: BuildPlanInput): Plan {
  const stack: Stack = input.stack ?? RECIPE_REGISTRY[input.recipe].stack;
  // Hands-off: the guidance carries a placeholder the user replaces with the key
  // they mint in the dashboard, never a live minted key.
  const otlp = buildOtlpSnippets({
    endpoint: input.endpoint,
    apiKey: KEY_PLACEHOLDER,
    serviceName: input.serviceName,
  });
  const snippet = [
    otlp.env,
    "",
    otlp.authHeader,
    "",
    otlp.serviceName,
    "",
    otlp.sessionAttr,
    "",
    `# ${otlp.note}`,
  ].join("\n");
  return {
    recipe: input.recipe,
    kind: "otlp-guidance",
    targetPath: null,
    content: null,
    snippet,
    // The receiver resolves an app from the standard `service.name` resource
    // attribute when the ingest key names none, so the OTLP path can declare
    // which app it is: the snippet sets OTEL_SERVICE_NAME and the prompt says
    // to keep it.
    agentPrompt: buildAgentPrompt(
      stack,
      { endpoint: input.endpoint, apiKey: KEY_PLACEHOLDER },
      { serviceName: input.serviceName },
    ),
    warnings: [],
  };
}

// --- dispatcher --------------------------------------------------------------

/**
 * Build the injection Plan for a detected recipe. Reads only (via `io`); the
 * returned Plan is plain data the executor applies all-or-nothing.
 */
export function buildPlan(
  input: BuildPlanInput,
  io: InjectIO = defaultInjectIO,
): Plan {
  const plan = dispatchPlan(input, io);
  // Stamp the env var the injected code reads its key from, so the wizard can
  // print "set <VAR> in .env — get your key from the dashboard". Undefined for
  // recipes that inject no key (tauri / otlp / angular) or when already wired.
  const keyRef = keyRefFor(input);
  if (keyRef && plan.kind !== "skip-already-wired") {
    plan.keyEnvVar = keyRef.envVar;
    if (keyRef.compileTime) plan.keyIsCompileTime = true;
  }
  return plan;
}

function dispatchPlan(input: BuildPlanInput, io: InjectIO): Plan {
  // Project-level idempotency runs first for every recipe.
  if (projectAlreadyWired(input.cwd, io)) {
    return skipPlan(input);
  }
  switch (input.recipe) {
    case "tauri":
      return planTauri(input, io);
    case "capacitor":
      return planCapacitor(input, io);
    case "flutter":
      return planFlutter(input, io);
    case "react-native":
      return planReactNative(input, io);
    case "next":
      return planNext(input, io);
    case "sveltekit":
      return planSvelteKit(input, io);
    case "nuxt":
      return planNuxt(input, io);
    case "remix":
      return planRemix(input, io);
    case "astro":
      return planAstro(input, io);
    case "angular":
      return planAngular(input, io);
    case "vite-spa":
      return planVite(input, io);
    case "express":
      // Express additionally wires the request/error middleware pair so the
      // backend emits backend.req.* spans, not just crash capture.
      return planExpress(input, io);
    case "nestjs":
    case "hono":
    case "fastify":
    case "node":
      // All backend-JS recipes share the headless-session injection; the agent
      // prompt differentiates framework middleware via the registry stack.
      return planNode(input, io);
    case "otlp":
      // Guidance-only, non-mutating path for non-JS OTLP backends.
      return planOtlp(input);
    default: {
      const exhaustive: never = input.recipe;
      throw new Error(`Unknown recipe: ${String(exhaustive)}`);
    }
  }
}
