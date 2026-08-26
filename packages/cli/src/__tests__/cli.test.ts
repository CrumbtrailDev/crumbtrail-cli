import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareSdkVersions,
  installSdk as realInstallSdk,
  isCliEntrypoint,
  normalizeRepoUrl,
  parseArgs,
  probeServiceKeys,
  resolveWorkspaceDir,
  runCli,
  sdkInstallSpecForCli,
  wizardAliasHint,
  type WizardDeps,
} from "../cli";
import {
  DENO_UNSUPPORTED_REASON,
  DOCKER_COMING_SOON_NOTE,
  type DetectResult,
  type Plan,
} from "../index";
import { RECIPE_REGISTRY, sdkInstallSpec } from "../recipe-registry";
import type { ServiceCandidate } from "../discover";
import type { Prompter, Ui } from "../ui";
import type { EnvFileIO } from "../env-file";
import { clearReportedAppBases, rememberAppBase, saveAuth } from "../auth";

function captureUi(): { ui: Ui; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    ui: {
      out: (l = "") => lines.push(l),
      err: (l = "") => lines.push(l),
    },
  };
}

const noopPrompter: Prompter = {
  ask: async (_q, d) => d ?? "",
  confirm: async (_q, d) => d ?? true,
  select: async (_q, _l, d) => d ?? 0,
  // Accept the checked defaults — the same thing pressing Enter does.
  multiSelect: async (_q, items) =>
    items
      .map((it, i) => (it.checked && it.selectable ? i : -1))
      .filter((i) => i >= 0),
};

function detectResult(over: Partial<DetectResult> = {}): DetectResult {
  return {
    cwd: "/app",
    packageJsonPath: "/app/package.json",
    recipe: "vite-spa",
    packageManager: "pnpm",
    entryFile: "/app/src/main.ts",
    nextVersion: null,
    otlpStack: null,
    isMonorepo: false,
    workspaces: [],
    ambiguous: false,
    reasons: [],
    notes: [],
    ...over,
  };
}

function createPlan(): Plan {
  return {
    recipe: "vite-spa",
    kind: "create",
    targetPath: "/app/src/main.ts",
    content: "// init",
    warnings: [],
    // The injected code reads its key from this env var, and the wizard mints
    // a key and writes it there.
    keyEnvVar: "VITE_CRUMBTRAIL_KEY",
  };
}

/**
 * An in-memory stand-in for the env writer's filesystem + git.
 *
 * Defaults describe the ordinary case: no env file yet, nothing tracked,
 * nothing ignored — so a fresh app creates `.env.local` AND gains a .gitignore
 * entry, which is the path most worth exercising.
 */
export function fakeEnvIO(
  seed: Record<string, string> = {},
  opts: { tracked?: string[]; ignored?: string[] } = {},
): EnvFileIO & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const matches = (list: string[] | undefined, target: string) =>
    (list ?? []).some((t) => target === t || target.endsWith(`/${t}`));
  return {
    files,
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, content) => {
      files.set(p, content);
    },
    remove: (p) => {
      files.delete(p);
    },
    isTracked: (_cwd, target) => matches(opts.tracked, target),
    isIgnored: (_cwd, target) => matches(opts.ignored, target),
  };
}

interface HarnessOpts {
  isTTY?: boolean;
  steps: string[];
}

function makeDeps(h: HarnessOpts, over: Partial<WizardDeps> = {}): WizardDeps {
  const { ui } = captureUi();
  const base: WizardDeps = {
    detect: vi.fn(() => {
      h.steps.push("detect");
      return detectResult();
    }),
    ensureToken: vi.fn(async () => {
      h.steps.push("login");
      return "ctcli_token";
    }) as unknown as WizardDeps["ensureToken"],
    provisionFlow: vi.fn(async () => {
      h.steps.push("provision");
      return {
        projectId: "p1",
        projectName: "checkout",
        serviceId: "s1",
        serviceName: "web",
      };
    }) as unknown as WizardDeps["provisionFlow"],
    createIngestKey: vi.fn(async () => {
      h.steps.push("mint-key");
      return { apiKey: "ctkey_test123", keyId: "key_test" };
    }) as unknown as WizardDeps["createIngestKey"],
    envFileIO: fakeEnvIO(),
    installSdk: vi.fn(async () => {
      h.steps.push("install");
      return { installed: true, packages: ["crumbtrail-core"] };
    }),
    buildPlan: vi.fn(() => {
      h.steps.push("build");
      return createPlan();
    }) as unknown as WizardDeps["buildPlan"],
    executePlan: vi.fn(() => {
      h.steps.push("execute");
      return {
        kind: "create" as const,
        written: ["/app/src/main.ts"],
        skipped: false,
        message: "Wrote 1 file(s).",
      };
    }) as unknown as WizardDeps["executePlan"],
    pollForRealEvent: vi.fn(async () => {
      h.steps.push("poll");
      return { outcome: "found" as const, sessionId: "sess-1" };
    }) as unknown as WizardDeps["pollForRealEvent"],
    discoverServices: vi.fn(() => {
      h.steps.push("discover");
      return [];
    }) as unknown as WizardDeps["discoverServices"],
    resolveProject: vi.fn(async () => {
      h.steps.push("project");
      return { id: "p1", name: "checkout" };
    }) as unknown as WizardDeps["resolveProject"],
    provisionService: vi.fn(async (input: { serviceName: string }) => {
      h.steps.push(`provision:${input.serviceName}`);
      return {
        serviceId: `svc-${input.serviceName}`,
        serviceName: input.serviceName,
      };
    }) as unknown as WizardDeps["provisionService"],
    setSessionReplay: vi.fn(async (_b, _t, _p, enabled: boolean) => {
      h.steps.push(`replay:${enabled ? "on" : "off"}`);
    }) as unknown as WizardDeps["setSessionReplay"],
    pollForServices: vi.fn(async (opts: { serviceIds: string[] }) => {
      h.steps.push("poll");
      return {
        outcome: "found" as const,
        found: Object.fromEntries(
          opts.serviceIds.map((id) => [id, `sess-${id}`]),
        ),
      };
    }) as unknown as WizardDeps["pollForServices"],
    runPreflight: vi.fn(async () => {
      h.steps.push("preflight");
      return {
        ok: true,
        endpoint: "https://api.crumbtrail.ai",
        stages: [],
      };
    }) as unknown as WizardDeps["runPreflight"],
    openBrowserFn: vi.fn(async () => true),
    ui,
    prompter: noopPrompter,
    // Pinned so the endpoint default never depends on whether the machine
    // running the suite happens to hold a `crumbtrail login`. Without this the
    // deps fall through to the real `loadAuth`, and a developer logged into a
    // local stack sees the hosted-default assertions fail while CI passes.
    loadStoredAuth: () => undefined,
    // DISPLAY pinned so canUseBrowser's headless-Linux guard doesn't make
    // browser-open assertions platform-dependent (CI runners have no X).
    env: { CRUMBTRAIL_BASE_URL: "http://127.0.0.1:9999", DISPLAY: ":0" },
    cwd: "/app",
    isTTY: h.isTTY ?? true,
    fetchImpl: undefined,
  };
  return { ...base, ...over };
}

describe("wizard first-event wait — what is actually outstanding", () => {
  it("blames the missing snippet, not the dev server, when nothing was injected", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps: [] },
      {
        ui,
        // fallback-ai prints a snippet and touches nothing. The key still
        // lands and the SDK still installs, so the old guard (install failed?)
        // never fired and the timeout told the user to restart an app that was
        // never wired.
        buildPlan: vi.fn(() => ({
          recipe: "vite-spa",
          kind: "fallback-ai" as const,
          warnings: [],
          keyEnvVar: "VITE_CRUMBTRAIL_KEY",
          snippet: "Crumbtrail.init({ key: process.env.VITE_CRUMBTRAIL_KEY })",
        })) as unknown as WizardDeps["buildPlan"],
        pollForRealEvent: vi.fn(async () => ({
          outcome: "timeout" as const,
        })) as unknown as WizardDeps["pollForRealEvent"],
      },
    );
    await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(out).toContain("still has to go into your entry file");
    expect(out).not.toContain("restart it if it was already running");
  });

  it("names the diagnostic that separates their problem from ours", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps: [] },
      {
        ui,
        pollForRealEvent: vi.fn(async () => ({
          outcome: "timeout" as const,
        })) as unknown as WizardDeps["pollForRealEvent"],
      },
    );
    await runCli(["node", "cli"], deps);
    // `crumbtrail verify` answers the whole "is it me or is it you" ticket
    // category, and appeared in usage() and nowhere a stuck person would look.
    expect(lines.join("\n")).toContain("npx crumbtrail verify");
  });
});

describe("normalizeRepoUrl", () => {
  // The identity sent with every create. Two clones of one repository have to
  // reduce to one string, or the CLI reports the same app as two.
  it("reduces every clone form of one repository to the same name", () => {
    for (const url of [
      "git@github.com:acme/billing.git",
      "https://github.com/acme/billing.git",
      "https://github.com/acme/billing",
      "ssh://git@github.com/acme/billing.git",
      "GIT@GitHub.com:Acme/Billing",
    ]) {
      expect(normalizeRepoUrl(url)).toBe("github.com/acme/billing");
    }
  });

  it("leaves a host it does not recognize alone rather than guessing", () => {
    expect(normalizeRepoUrl("https://git.internal:7999/team/app.git")).toBe(
      "git.internal:7999/team/app",
    );
  });
});

describe("the final verdict says whether anything was captured", () => {
  // "Setup complete" used to be decided by the ingest key alone, so a run that
  // had just printed "No event yet, start your app" still certified itself as
  // done three lines later. The README's promise is a confirmed first event.
  const timingOut = (ui: Ui) =>
    makeDeps(
      { steps: [] },
      {
        ui,
        pollForRealEvent: vi.fn(async () => ({
          outcome: "timeout" as const,
        })) as unknown as WizardDeps["pollForRealEvent"],
      },
    );

  it("will not call a run complete when no event ever arrived", async () => {
    const { ui, lines } = captureUi();
    const code = await runCli(["node", "cli"], timingOut(ui));
    const out = lines.join("\n");
    expect(out).not.toContain("Setup complete");
    expect(out).toContain("Wiring complete. No event captured yet.");
    // Nothing is outstanding for the reader to fix, so this is not a failure a
    // script should act on: the app has simply not been started yet.
    expect(code).toBe(0);
  });

  it("calls it complete once the event is in", async () => {
    const { ui, lines } = captureUi();
    const code = await runCli(["node", "cli"], makeDeps({ steps: [] }, { ui }));
    expect(lines.join("\n")).toContain("Setup complete. First event received.");
    expect(code).toBe(0);
  });

  it("claims nothing about capture when the wait was skipped", async () => {
    const { ui, lines } = captureUi();
    await runCli(["node", "cli", "--skip-verify"], makeDeps({ steps: [] }, { ui }));
    const out = lines.join("\n");
    expect(out).toContain("Wiring complete. First event not verified.");
    expect(out).not.toContain("Setup complete");
  });

  it("calls the object what the dashboard calls it", async () => {
    const { ui, lines } = captureUi();
    await runCli(["node", "cli"], makeDeps({ steps: [] }, { ui }));
    expect(lines.join("\n")).toMatch(/Application:\s+web/);
  });
});

describe("Node version floor", () => {
  it("stops before touching the repo on a Node older than the engines range", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    const code = await runCli(["node", "cli"], deps, "v20.11.0");
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Node 22.15.0 or newer");
    expect(lines.join("\n")).toContain("Node 20.11.0");
    // npm only warns on an unmet engines range, so nothing else stops this.
    expect(deps.detect).not.toHaveBeenCalled();
  });

  it("runs on a Node at or above the floor", async () => {
    const deps = makeDeps({ steps: [] });
    expect(await runCli(["node", "cli"], deps, "v22.15.0")).toBe(0);
    expect(await runCli(["node", "cli"], deps, "v24.0.0")).toBe(0);
  });
});

describe("parseArgs", () => {
  it("parses flags, subcommands, and both --k v / --k=v forms", () => {
    expect(parseArgs(["node", "cli", "--help"]).command).toBe("help");
    expect(parseArgs(["node", "cli", "-v"]).command).toBe("version");
    expect(parseArgs(["node", "cli", "login"]).command).toBe("login");
    const p = parseArgs([
      "node",
      "cli",
      "--yes",
      "--project=proj_1",
      "--no-browser",
      "--skip-verify",
      "--endpoint",
      "https://x",
    ]);
    expect(p).toMatchObject({
      command: "wizard",
      yes: true,
      project: "proj_1",
      noBrowser: true,
      skipVerify: true,
      endpoint: "https://x",
    });
  });

  it("parses --workspace in both --k v and --k=v forms", () => {
    expect(
      parseArgs(["node", "cli", "--workspace", "apps/web"]).workspace,
    ).toBe("apps/web");
    expect(
      parseArgs(["node", "cli", "--workspace=packages/api"]).workspace,
    ).toBe("packages/api");
    expect(parseArgs(["node", "cli"]).workspace).toBeUndefined();
  });

  it("parses the verify subcommand with --key/--json (both flag forms)", () => {
    const p = parseArgs([
      "node",
      "cli",
      "verify",
      "--endpoint",
      "https://api.example",
      "--key",
      "ck_abc",
      "--json",
    ]);
    expect(p).toMatchObject({
      command: "verify",
      endpoint: "https://api.example",
      key: "ck_abc",
      json: true,
    });
    expect(parseArgs(["node", "cli", "verify", "--key=ck_xyz"]).key).toBe(
      "ck_xyz",
    );
    expect(parseArgs(["node", "cli"]).json).toBe(false);
  });
});

describe("verify subcommand dispatch", () => {
  it("runs the preflight (no TTY guard) and maps PASS to exit 0", async () => {
    const h: HarnessOpts = { steps: [], isTTY: false };
    const runPreflight = vi.fn(async () => ({
      ok: true,
      endpoint: "https://api.crumbtrail.ai",
      stages: [
        { stage: "dns" as const, status: "pass" as const, reason: "ok", ms: 1 },
      ],
    })) as unknown as WizardDeps["runPreflight"];
    const deps = makeDeps(h, {
      runPreflight,
      env: { CRUMBTRAIL_KEY: "ck_env" },
    });
    const code = await runCli(["node", "cli", "verify"], deps);
    expect(code).toBe(0);
    expect(runPreflight).toHaveBeenCalledTimes(1);
    // The ingest key from $CRUMBTRAIL_KEY became the probe credential.
    expect(runPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://api.crumbtrail.ai",
        probe: { kind: "ingestKey", key: "ck_env" },
      }),
    );
  });

  it("maps a FAIL preflight to a non-zero exit and emits JSON with --json", async () => {
    const h: HarnessOpts = { steps: [], isTTY: false };
    const { ui, lines } = captureUi();
    const runPreflight = vi.fn(async () => ({
      ok: false,
      endpoint: "https://api.crumbtrail.ai",
      stages: [
        {
          stage: "auth" as const,
          status: "fail" as const,
          reason: "bad or expired ingest key (HTTP 401)",
          ms: 12,
        },
      ],
    })) as unknown as WizardDeps["runPreflight"];
    const deps = makeDeps(h, {
      runPreflight,
      ui,
      env: { CRUMBTRAIL_KEY: "ck" },
    });
    const code = await runCli(["node", "cli", "verify", "--json"], deps);
    expect(code).toBe(1);
    const parsed = JSON.parse(lines.join("\n").trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.stages[0].reason).toMatch(/bad or expired/);
  });
});

describe("resolveWorkspaceDir (--workspace validation)", () => {
  const io = (dirs: string[], files: string[]) => ({
    isDir: (p: string) => dirs.includes(p),
    isFile: (p: string) => files.includes(p),
  });

  it("resolves a dir that exists and holds a package.json", () => {
    const res = resolveWorkspaceDir(
      "/repo",
      "apps/web",
      io(["/repo/apps/web"], ["/repo/apps/web/package.json"]),
    );
    expect(res).toEqual({ dir: "/repo/apps/web" });
  });

  it("errors when the dir does not exist", () => {
    const res = resolveWorkspaceDir("/repo", "apps/ghost", io([], []));
    expect("error" in res && res.error).toMatch(/no such directory/);
  });

  it("errors when the dir has no package.json", () => {
    const res = resolveWorkspaceDir(
      "/repo",
      "services/rails",
      io(["/repo/services/rails"], []),
    );
    expect("error" in res && res.error).toMatch(/no package\.json/);
  });
});

// Session replay is the one capture setting a team cannot discover by using
// the product: a session without a recording renders as an explanation, not as
// a missing player. Setup is where it gets asked, and these pin what setup is
// allowed to decide on the asker's behalf — which is nothing.
describe("session replay at setup", () => {
  it("turns replay on when the person says yes, and says so", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      { ui, prompter: { ...noopPrompter, confirm: async () => true } },
    );

    expect(await runCli(["node", "cli"], deps)).toBe(0);
    expect(steps).toContain("replay:on");
    expect(lines.join("\n")).toContain("Session replay is on");
  });

  it("writes nothing when the person says no, because off is already the state", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      { ui, prompter: { ...noopPrompter, confirm: async () => false } },
    );

    expect(await runCli(["node", "cli"], deps)).toBe(0);
    // A "no" that patched the project would silently switch replay OFF for a
    // project that already records, which is not what the question asked.
    expect(steps).not.toContain("replay:off");
    expect(steps).not.toContain("replay:on");
    expect(lines.join("\n")).toContain("capture settings");
  });

  it("never asks, and never writes, without a person at the terminal", async () => {
    const steps: string[] = [];
    const confirm = vi.fn(async () => true);
    const { ui } = captureUi();
    const deps = makeDeps(
      { steps, isTTY: false },
      { ui, prompter: { ...noopPrompter, confirm } },
    );

    // Whatever else a headless run decides, it does not decide this.
    await runCli(["node", "cli"], deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(steps.filter((s) => s.startsWith("replay:"))).toEqual([]);
  });

  it("carries out --replay and --no-replay without asking", async () => {
    for (const [flag, step] of [
      ["--replay", "replay:on"],
      ["--no-replay", "replay:off"],
    ] as const) {
      const steps: string[] = [];
      const confirm = vi.fn(async () => true);
      const { ui } = captureUi();
      const deps = makeDeps(
        { steps },
        { ui, prompter: { ...noopPrompter, confirm } },
      );

      expect(await runCli(["node", "cli", flag], deps)).toBe(0);
      expect(confirm).not.toHaveBeenCalled();
      expect(steps).toContain(step);
    }
  });

  it("reports a refused setting instead of failing the run that already wired the app", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        prompter: { ...noopPrompter, confirm: async () => true },
        setSessionReplay: (async () => {
          throw new Error("you do not manage this project");
        }) as unknown as WizardDeps["setSessionReplay"],
      },
    );

    // The app is wired. A setting that would not take is a note, not a failure.
    expect(await runCli(["node", "cli"], deps)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("left unchanged");
    expect(out).toContain("you do not manage this project");
  });
});

describe("wizard orchestration", () => {
  it("runs steps in the documented order and prints a summary", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    // buildPlan runs BEFORE installSdk (it must analyze the pre-install repo so
    // its idempotency check doesn't see the SDK deps installSdk just added and
    // self-cancel injection); executePlan still runs last, after install.
    //
    // The key is minted AFTER execute and BEFORE poll, and that order is the
    // point: minting last means every refusal path costs no credential, and
    // minting before the wait means the wait is on the app starting rather than
    // on a manual step nobody was told to do.
    expect(steps).toEqual([
      "detect",
      "login",
      "provision",
      "build",
      "install",
      "execute",
      "mint-key",
      "preflight",
      "poll",
    ]);
    const out = lines.join("\n");
    expect(out).toContain("checkout"); // project
    expect(out).toContain("web"); // service
    // The variable is named, and the summary reports the key as placed rather
    // than handing the job back.
    expect(out).toContain("VITE_CRUMBTRAIL_KEY");
    expect(out).toMatch(/wrote VITE_CRUMBTRAIL_KEY to/i);
    // Which key. Minting is additive on purpose, so after a second run the
    // project holds two live keys and the dashboard list cannot say which one
    // is in this app's env file. The tail can, and it is the only half of the
    // answer the reader can look up: the id the API returns beside it is a
    // database row id that neither the env file nor the dashboard prints, so
    // "internal id key_test" was an identifier with nowhere to match it.
    expect(out).toMatch(/ending est123/);
    expect(out).not.toContain("internal id");
    expect(out).not.toContain("key_test");
    // The key VALUE still never reaches the terminal. Scrollback, CI logs and
    // screen shares all outlive the run.
    expect(out).not.toMatch(/ctkey_|bgk_|bl_key_/);
    expect(out).toContain("/issues"); // dashboard link
    expect(out).toContain("/sessions/sess-1"); // deep link to the live session
    expect(out).toContain("/app/src/main.ts"); // injection names the file
  });

  it("names the app it just created in the injected init", async () => {
    // The wizard provisions the service and prints its name, then wired code
    // that reported under no app at all: sessions arrived project-scoped and
    // unattributed, invisible to the confirm step that matches by service.
    const steps: string[] = [];
    const seen: (string | null | undefined)[] = [];
    const deps = makeDeps(
      { steps },
      {
        buildPlan: vi.fn((input: { serviceName?: string | null }) => {
          steps.push("build");
          seen.push(input.serviceName);
          return createPlan();
        }) as unknown as WizardDeps["buildPlan"],
      },
    );
    await runCli(["node", "cli"], deps);
    // provisionFlow returned serviceName "web".
    expect(seen).toEqual(["web"]);
  });

  it("opens the live session in the browser on the first real event", async () => {
    const steps: string[] = [];
    const openBrowserFn = vi.fn(async () => true);
    const deps = makeDeps({ steps }, { openBrowserFn });
    await runCli(["node", "cli"], deps);
    // Project scoped. A bare /sessions/<id> hits the dashboard's catch-all,
    // which drops the id and picks the project from the browser's last-used
    // value — so the payoff link opened some other project's session list.
    expect(openBrowserFn).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/p/p1/sessions/sess-1",
    );
  });

  it("prints the deep link but never opens a browser with --no-browser", async () => {
    const steps: string[] = [];
    const openBrowserFn = vi.fn(async () => true);
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { openBrowserFn, ui });
    await runCli(["node", "cli", "--no-browser"], deps);
    expect(openBrowserFn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("/sessions/sess-1");
  });

  it("writes nothing when the SDK could not be installed", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        installSdk: vi.fn(async () => {
          steps.push("install");
          return {
            installed: false,
            packages: ["crumbtrail_flutter"],
            note: "crumbtrail_flutter is not published on pub.dev yet, so this app cannot be wired automatically. Nothing was installed and no files were changed.",
          };
        }),
      },
    );

    await runCli(["node", "cli"], deps);

    // An import for a package that is not installed does not fail softly: it
    // fails the build. Wiring it anyway left the user with an app that no
    // longer compiled and an edit they had to find and revert by hand, while
    // every step printed afterwards reported success.
    expect(steps).not.toContain("execute");
    expect(deps.executePlan).not.toHaveBeenCalled();
    const out = lines.join("\n");
    expect(out).toContain("Left your code untouched");
    expect(out).toContain("not published on pub.dev");
    expect(steps).not.toContain("mint-key");
    expect(out).toMatch(/setup incomplete/i);
    // And no countdown on an event that cannot arrive.
    expect(steps).not.toContain("poll");
  });

  it("probes a written key and reports a rejected key before waiting", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const pollForRealEvent = vi.fn(async () => {
      steps.push("poll");
      return { outcome: "timedout" as const };
    }) as unknown as WizardDeps["pollForRealEvent"];
    const runPreflight = vi.fn(async () => {
      steps.push("preflight");
      return {
        ok: false,
        endpoint: "http://127.0.0.1:9999",
        stages: [
          {
            stage: "auth" as const,
            status: "fail" as const,
            reason:
              "ingest key rejected: key belongs to another project (HTTP 401)",
            ms: 1,
          },
        ],
      };
    }) as unknown as WizardDeps["runPreflight"];
    const deps = makeDeps({ steps }, { ui, pollForRealEvent, runPreflight });

    await runCli(["node", "cli"], deps);

    expect(steps).toContain("mint-key");
    expect(steps).toContain("preflight");
    expect(steps).not.toContain("poll");
    expect(lines.join("\n")).toContain("key belongs to another project");
    expect(lines.join("\n")).toContain("First-event wait skipped");
  });

  it("does not wait for a Tauri cloud event", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => detectResult({ recipe: "tauri" })),
        buildPlan: vi.fn(() => ({
          recipe: "tauri",
          kind: "create" as const,
          targetPath: "/app/src/main.ts",
          content: "// tauri init",
          warnings: ["Complete the Rust plugin steps."],
        })) as unknown as WizardDeps["buildPlan"],
      },
    );

    await runCli(["node", "cli"], deps);

    expect(steps).not.toContain("poll");
    expect(lines.join("\n")).toContain("stores events locally");
  });

  it("plans before install, installs before executing (build<install<execute)", async () => {
    const steps: string[] = [];
    const deps = makeDeps({ steps });
    await runCli(["node", "cli"], deps);
    expect(steps.indexOf("build")).toBeLessThan(steps.indexOf("install"));
    expect(steps.indexOf("install")).toBeLessThan(steps.indexOf("execute"));
  });

  it("writes the minted key into the app's env file and excludes that file", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO();
    const { ui, lines } = captureUi();
    await runCli(["node", "cli"], makeDeps({ steps }, { ui, envFileIO }));

    expect(envFileIO.files.get("/app/.env.local")).toContain(
      "VITE_CRUMBTRAIL_KEY=ctkey_test123",
    );
    // A secret in a file that would be committed on the next `git add .` is the
    // failure the ignore entry exists to prevent.
    expect(envFileIO.files.get("/app/.gitignore")).toContain(".env.local");
    // And the reader is told, because their env file has just quietly stopped
    // appearing in `git status`.
    expect(lines.join("\n")).toMatch(/added .* to \.gitignore/i);
  });

  it("writes no env file for a compile-time key, and says --dart-define instead", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO();
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        envFileIO,
        buildPlan: vi.fn(() => {
          steps.push("build");
          return {
            recipe: "flutter",
            kind: "rewrite",
            targetPath: "/app/lib/main.dart",
            content: "// wired",
            warnings: [],
            keyEnvVar: "CRUMBTRAIL_KEY",
            keyIsCompileTime: true,
          } as Plan;
        }) as unknown as WizardDeps["buildPlan"],
      },
    );
    await runCli(["node", "cli"], deps);

    // Dart bakes the value in at build time. A .env here would be a live
    // credential in a file the app never reads, with every printed step
    // reporting success for an app that captures nothing.
    expect(envFileIO.files.size).toBe(0);
    expect(steps).not.toContain("mint-key");
    expect(lines.join("\n")).toContain("--dart-define=CRUMBTRAIL_KEY");
  });

  // Adding the file to .gitignore afterwards would not untrack it, so the very
  // next commit would publish the key. Nothing is minted at all.
  it("mints nothing when the env file is tracked by git", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO(
      { "/app/.env": "EXISTING=1\n" },
      { tracked: [".env"] },
    );
    const { ui, lines } = captureUi();
    await runCli(["node", "cli"], makeDeps({ steps }, { ui, envFileIO }));

    expect(steps).not.toContain("mint-key");
    expect(envFileIO.files.get("/app/.env")).toBe("EXISTING=1\n");
    const out = lines.join("\n");
    expect(out).toMatch(/tracked by git/i);
    // And it still says what to do instead, rather than only refusing.
    expect(out).toMatch(/VITE_CRUMBTRAIL_KEY/);
  });

  it("mints nothing when the variable already holds a key", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO({
      "/app/.env.local": "VITE_CRUMBTRAIL_KEY=ctkey_theirs\n",
    });
    const { ui, lines } = captureUi();
    await runCli(["node", "cli"], makeDeps({ steps }, { ui, envFileIO }));

    expect(steps).not.toContain("mint-key");
    expect(envFileIO.files.get("/app/.env.local")).toBe(
      "VITE_CRUMBTRAIL_KEY=ctkey_theirs\n",
    );
    expect(lines.join("\n")).toMatch(/already set/i);
  });

  it("--no-write-key mints nothing and hands the variable back", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO();
    const { ui, lines } = captureUi();
    await runCli(
      ["node", "cli", "--no-write-key"],
      makeDeps({ steps }, { ui, envFileIO }),
    );

    expect(steps).not.toContain("mint-key");
    expect(envFileIO.files.size).toBe(0);
    expect(lines.join("\n")).toMatch(/--no-write-key/);
  });

  it("keeps the wiring when the key write fails, and says the key is unplaced", async () => {
    const steps: string[] = [];
    const envFileIO = fakeEnvIO();
    const failing = {
      ...envFileIO,
      writeFile: () => {
        throw new Error("read-only filesystem");
      },
    };
    const { ui, lines } = captureUi();
    const code = await runCli(
      ["node", "cli"],
      makeDeps({ steps }, { ui, envFileIO: failing }),
    );

    // The injection above it is still correct and worth keeping, so a failed
    // env write reports rather than rolling the wiring back. The run is still
    // unfinished though: without the key on disk the app reports nothing, the
    // summary says "Setup incomplete", and the exit code has to agree with it
    // or a script reads this run as a success.
    expect(code).toBe(1);
    expect(steps).toContain("execute");
    const out = lines.join("\n");
    expect(out).toContain("Setup incomplete");
    expect(out).toMatch(/could not write it/i);
    expect(out).not.toMatch(/ctkey_/);
  });
});

describe("installSdk — tarball fallback (registry unavailable)", () => {
  const uiSink: Ui = { out: () => {}, err: () => {} };

  it("refuses to add a package that is not on its registry, and says why", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: null,
      recipe: "flutter",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn: (cmd, args) => {
        calls.push({ cmd, args });
        return 0;
      },
      fetchImpl: (async () => {
        throw new Error("the pub path must not touch the network");
      }) as unknown as typeof fetch,
    });

    // `crumbtrail_flutter` is built here but has never been released, so
    // `flutter pub add` can only fail — at dependency resolution, with an exit
    // code that says nothing about why. Running it anyway produced a failure
    // the wizard then explained wrongly, sending the user to check their PATH.
    expect(calls).toEqual([]);
    expect(result.installed).toBe(false);
    expect(result.note).toContain("pub.dev");
    expect(result.note).toContain("crumbtrail_flutter");
  });

  it("uses pub, never a JS package manager, once the package is published", async () => {
    // The day `crumbtrail_flutter` ships, `sdkUnpublished` comes off the
    // registry entry and this is the path that runs. Removing it here keeps
    // that path covered instead of leaving it untested until the release.
    const meta = RECIPE_REGISTRY.flutter;
    const wasUnpublished = meta.sdkUnpublished;
    delete meta.sdkUnpublished;
    const calls: { cmd: string; args: string[] }[] = [];
    try {
      const result = await realInstallSdk({
        cwd: "/app",
        // Detection finds no lockfile in a Flutter app, and it does not matter:
        // a Dart package is not on npm, so the package manager is irrelevant.
        packageManager: null,
        recipe: "flutter",
        base: "https://deploy.example",
        ui: uiSink,
        spawnFn: (cmd, args) => {
          calls.push({ cmd, args });
          return 0;
        },
        fetchImpl: (async () => {
          throw new Error("the pub path must not touch the network");
        }) as unknown as typeof fetch,
      });

      expect(result.installed).toBe(true);
      expect(calls).toEqual([
        { cmd: "flutter", args: ["pub", "add", "crumbtrail_flutter"] },
      ]);
      // npm version floors are spelled `pkg@>=x.y.z` and mean nothing to pub.
      expect(JSON.stringify(calls)).not.toContain(">=");
    } finally {
      if (wasUnpublished) meta.sdkUnpublished = wasUnpublished;
    }
  });

  it("names no cause when pub add itself fails", async () => {
    const meta = RECIPE_REGISTRY.flutter;
    const wasUnpublished = meta.sdkUnpublished;
    delete meta.sdkUnpublished;
    try {
      const result = await realInstallSdk({
        cwd: "/app",
        packageManager: null,
        recipe: "flutter",
        base: "https://deploy.example",
        ui: uiSink,
        spawnFn: () => 1,
        fetchImpl: (async () => {
          // The deploy's tarball fallback serves npm tarballs; there is nothing
          // there for a Dart package, so it must not be attempted.
          throw new Error("no tarball fallback for pub");
        }) as unknown as typeof fetch,
      });
      expect(result.installed).toBe(false);
      // An exit code says the command failed, not why. "Check your PATH" was a
      // guess, and it sent Flutter users to debug a toolchain that was fine.
      expect(result.note).not.toMatch(/PATH/i);
      expect(result.note).toContain("flutter pub add crumbtrail_flutter");
    } finally {
      if (wasUnpublished) meta.sdkUnpublished = wasUnpublished;
    }
  });

  it("falls back to the deploy's /install tarballs when the registry install fails", async () => {
    const calls: string[][] = [];
    // First (registry) install fails; the tarball-URL install succeeds.
    const spawnFn = (_cmd: string, args: string[]) => {
      calls.push(args);
      return calls.length === 1 ? 1 : 0;
    };
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("https://deploy.example/install/manifest.json");
      return {
        ok: true,
        json: async () => ({
          schemaVersion: "install-manifest.v1",
          files: [
            "crumbtrail-core-0.1.0.tgz",
            "crumbtrail-node-0.1.0.tgz",
            "crumbtrail-0.1.0.tgz",
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "npm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn,
      fetchImpl,
    });

    expect(result.installed).toBe(true);
    expect(result.note).toContain("install tarballs");
    // Second spawn installs the discovered tarball URLs (core + node).
    expect(calls[1]).toEqual([
      "install",
      "https://deploy.example/install/crumbtrail-core-0.1.0.tgz",
      "https://deploy.example/install/crumbtrail-node-0.1.0.tgz",
    ]);
  });

  it("resolves react-native + tauri from the deploy's optional tarball channels", async () => {
    // CP5: react-native is packed as an optional channel now, so a failed
    // registry install must fall through to the SAME manifest-driven tarball
    // discovery as the core recipes (no more 'not yet distributable' dead-end).
    //
    // Tauri is in this loop with NO second package: TauriTransport ships as the
    // crumbtrail-core/tauri subpath, so the tarball it needs is the core one it
    // already installs. Keeping it here proves the tauri recipe still probes the
    // manifest rather than dead-ending, which is the behaviour CP5 added.
    const extraPackage = {
      "react-native": "crumbtrail-react-native",
      tauri: null,
    } as const;
    for (const recipe of ["react-native", "tauri"] as const) {
      const pkg = extraPackage[recipe];
      const calls: string[][] = [];
      const spawnFn = (_cmd: string, args: string[]) => {
        calls.push(args);
        return calls.length === 1 ? 1 : 0; // registry fails, tarball install ok
      };
      let probed = false;
      const fetchImpl = (async (url: string) => {
        probed = true;
        expect(url).toBe("https://deploy.example/install/manifest.json");
        return {
          ok: true,
          json: async () => ({
            schemaVersion: "install-manifest.v1",
            files: [
              "crumbtrail-core-0.1.0.tgz",
              "crumbtrail-node-0.1.0.tgz",
              "crumbtrail-0.1.0.tgz",
              "crumbtrail-react-native-0.1.0.tgz",
            ],
          }),
        };
      }) as unknown as typeof fetch;

      const result = await realInstallSdk({
        cwd: "/app",
        packageManager: "npm",
        recipe,
        base: "https://deploy.example",
        ui: uiSink,
        spawnFn,
        fetchImpl,
      });

      expect(probed).toBe(true); // DID probe the manifest (was skipped before CP5)
      expect(result.installed).toBe(true);
      expect(result.note).toContain("install tarballs");
      // Second spawn installs the discovered tarball URLs: core, plus the SDK
      // package when the recipe has one of its own.
      expect(calls[1]).toEqual([
        "install",
        "https://deploy.example/install/crumbtrail-core-0.1.0.tgz",
        ...(pkg ? [`https://deploy.example/install/${pkg}-0.1.0.tgz`] : []),
      ]);
    }
  });
});

// ── Batch installer (monorepo root) ─────────────────────────────────────────

function candidate(over: Partial<ServiceCandidate> = {}): ServiceCandidate {
  const relDir = over.relDir ?? "apps/web";
  return {
    dir: `/app/${relDir}`,
    name: relDir.split("/").pop() as string,
    relDir,
    source: "workspace",
    detected: detectResult({ cwd: `/app/${relDir}` }),
    recipe: "vite-spa",
    flags: [],
    defaultChecked: true,
    selectable: true,
    ...over,
  };
}

/** Root detect() result — the only thing that routes us into the batch path. */
function monorepoRoot(): DetectResult {
  return detectResult({
    cwd: "/app",
    isMonorepo: true,
    ambiguous: true,
    recipe: null,
    entryFile: null,
    workspaces: [{ name: "web", dir: "/app/apps/web" }],
  });
}

/**
 * Batch deps whose per-service steps carry the service's directory, so ordering
 * assertions can prove `build:X` precedes `install:X` for every X.
 */
function batchDeps(
  steps: string[],
  candidates: ServiceCandidate[],
  over: Partial<WizardDeps> = {},
): WizardDeps {
  return makeDeps(
    { steps },
    {
      detect: vi.fn(() => {
        steps.push("detect");
        return monorepoRoot();
      }),
      discoverServices: vi.fn(() => {
        steps.push("discover");
        return candidates;
      }) as unknown as WizardDeps["discoverServices"],
      buildPlan: vi.fn((input: { cwd: string }) => {
        steps.push(`build:${input.cwd}`);
        return { ...createPlan(), targetPath: `${input.cwd}/src/main.ts` };
      }) as unknown as WizardDeps["buildPlan"],
      installSdk: vi.fn(async (input: { cwd: string }) => {
        steps.push(`install:${input.cwd}`);
        return { installed: true, packages: ["crumbtrail-core"] };
      }) as unknown as WizardDeps["installSdk"],
      executePlan: vi.fn((plan: Plan) => {
        steps.push(`execute:${plan.targetPath}`);
        return {
          kind: plan.kind,
          written: [plan.targetPath as string],
          skipped: false,
          message: "Wrote 1 file(s).",
        };
      }) as unknown as WizardDeps["executePlan"],
      ...over,
    },
  );
}

// Defect class: a repo root with no framework of its own but real sibling
// services. --help promises the root run scans every service; it used to print
// "No supported framework" and tell the reader to cd into each directory.
describe("batch installer (unlinked sibling services)", () => {
  function siblingDeps(steps: string[], candidates: ServiceCandidate[]) {
    const seen: { includeUnlinkedApps?: boolean }[] = [];
    const deps = batchDeps(steps, candidates, {
      detect: vi.fn(() => {
        steps.push("detect");
        // No workspaces, no recipe — the exact shape that used to dead-end.
        return detectResult({
          cwd: "/app",
          isMonorepo: false,
          ambiguous: true,
          recipe: null,
          entryFile: null,
          reasons: [
            "looked in /app; package.json has no dependencies matching a recipe",
          ],
        });
      }),
      discoverServices: vi.fn(
        (
          _root: string,
          _rootResult: DetectResult,
          _reader: unknown,
          over: { includeUnlinkedApps?: boolean } = {},
        ) => {
          steps.push("discover");
          seen.push(over);
          return over.includeUnlinkedApps ? candidates : [];
        },
      ) as unknown as WizardDeps["discoverServices"],
    });
    return { deps, seen };
  }

  it("offers both sibling services from the root instead of dead-ending", async () => {
    const steps: string[] = [];
    const { deps, seen } = siblingDeps(steps, [
      candidate({ relDir: "admin", recipe: "vite-spa", source: "scan" }),
      candidate({ relDir: "api", recipe: "hono", source: "scan" }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli", "--all"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain("No supported framework");
    expect(out).not.toContain("cd apps/web && npx crumbtrail");
    expect(out).toContain("Repo root");
    expect(steps).toContain("provision:admin");
    expect(steps).toContain("provision:api");
    // One login and one project for the pair, exactly like a real workspace.
    expect(steps.filter((s) => s === "login")).toHaveLength(1);
    expect(steps.filter((s) => s === "project")).toHaveLength(1);
    expect(seen.every((o) => o.includeUnlinkedApps === true)).toBe(true);
  });

  it("still dead-ends honestly when nothing nearby is wireable", async () => {
    const steps: string[] = [];
    const { deps } = siblingDeps(steps, []);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("No supported framework in /app");
  });
});

describe("batch installer: an empty selection has two opposite meanings", () => {
  // A rerun in a repository that is fully wired opens the list with every box
  // unchecked, because "already wired" is exactly what turns the default off.
  // Pressing Enter then printed "Nothing selected, no changes made", which is
  // the same sentence a reader gets when the CLI found nothing it could wire.
  it("says the repository is already wired rather than that nothing was picked", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", flags: ["already-wired"], defaultChecked: false }),
      candidate({
        relDir: "services/api",
        recipe: "express",
        flags: ["already-wired"],
        defaultChecked: false,
      }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("already wired for");
    expect(out).toContain("Nothing to do");
    expect(out).not.toContain("Nothing selected");
    // Nothing was provisioned to say it: the answer is known before login.
    expect(steps).not.toContain("login");
  });

  it("still says nothing was picked when there was something to pick", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", defaultChecked: false }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Nothing selected");
  });
});

describe("batch installer (monorepo root)", () => {
  it("wires every checked service: one login, one project, one poll", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ]);

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);

    // Login, project, and the shared poll happen exactly once for the batch.
    expect(steps.filter((s) => s === "login")).toHaveLength(1);
    expect(steps.filter((s) => s === "project")).toHaveLength(1);
    expect(steps.filter((s) => s === "poll")).toHaveLength(1);

    // Both services provisioned, each named from its workspace package name.
    expect(steps).toContain("provision:web");
    expect(steps).toContain("provision:api");

    // The load-bearing invariant: for EACH dir, the plan is built before the
    // SDK is installed — otherwise buildPlan sees crumbtrail-core in package.json
    // and self-cancels to skip-already-wired.
    for (const dir of ["/app/apps/web", "/app/services/api"]) {
      expect(steps.indexOf(`build:${dir}`)).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(`build:${dir}`)).toBeLessThan(
        steps.indexOf(`install:${dir}`),
      );
      expect(steps.indexOf(`install:${dir}`)).toBeLessThan(
        steps.indexOf(`execute:${dir}/src/main.ts`),
      );
    }
  });

  it("keeps going when one service fails, and reports it", async () => {
    const steps: string[] = [];
    const deps = batchDeps(
      steps,
      [
        candidate({ relDir: "apps/web", recipe: "next" }),
        candidate({ relDir: "services/api", recipe: "express" }),
        candidate({ relDir: "apps/admin", recipe: "next" }),
      ],
      {
        executePlan: vi.fn((plan: Plan) => {
          steps.push(`execute:${plan.targetPath}`);
          if (plan.targetPath?.includes("services/api")) {
            throw new Error("refusing to overwrite existing file");
          }
          return {
            kind: plan.kind,
            written: [plan.targetPath as string],
            skipped: false,
            message: "Wrote 1 file(s).",
          };
        }) as unknown as WizardDeps["executePlan"],
      },
    );
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);

    // A partial batch is not a success. It prints "Setup incomplete. 1 of 3
    // applications still need you", and a CI step that wires a repository has
    // to be able to act on that: exit 0 here meant a pipeline went green with
    // a service that reports nothing.
    expect(code).toBe(1);
    // The service AFTER the failure still ran: the batch did not abort.
    expect(steps).toContain("provision:admin");
    expect(steps).toContain("execute:/app/apps/admin/src/main.ts");

    const out = lines.join("\n");
    expect(out).toContain("refusing to overwrite existing file");
    expect(out).toContain("2 wired");
    expect(out).toContain("1 failed");
    expect(out).toContain("Run `crumbtrail` again to retry");
  });

  it("does not call code changes wired when the key is still missing", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web" }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    await runCli(["node", "cli", "--no-write-key"], deps);

    const out = lines.join("\n");
    expect(out).toContain("Setup incomplete");
    expect(out).toContain("0 wired");
    expect(out).toContain("2 need a key");
    expect(out).not.toContain("Setup complete");
    expect(out).toContain("Set VITE_CRUMBTRAIL_KEY yourself");
    expect(out).toContain("/p/p1/setup");
    expect(out).not.toContain("/settings");
  });

  it("injects the name it PROVISIONED, not the raw package name", async () => {
    // apps/web is published as @acme/web; the service is provisioned as `web`
    // (inferServiceName strips the scope, uniqueServiceNames de-collides). If
    // the injected init says "@acme/web" the sessions are filed under a label no
    // provisioned service has, and the batch verify — which polls the
    // PROVISIONED service ids — can never match, so every service reports
    // "No event yet" while events are landing.
    const steps: string[] = [];
    const seen: (string | null | undefined)[] = [];
    const deps = batchDeps(
      steps,
      [candidate({ relDir: "apps/web", name: "@acme/web", recipe: "next" })],
      {
        buildPlan: vi.fn((input: { cwd: string; serviceName?: string }) => {
          steps.push(`build:${input.cwd}`);
          seen.push(input.serviceName);
          return { ...createPlan(), targetPath: `${input.cwd}/src/main.ts` };
        }) as unknown as WizardDeps["buildPlan"],
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    expect(steps).toContain("provision:web");
    expect(seen).toEqual(["web"]);
  });

  it("says what actually happened when the SDK install failed", async () => {
    // Zero files touched is not the same as "already wired": wiring is withheld
    // on purpose when the SDK could not be installed. Reporting that row as
    // "already wired — skipped" tells the user a service is set up when nothing
    // happened to it.
    const steps: string[] = [];
    const deps = batchDeps(
      steps,
      [candidate({ relDir: "services/api", recipe: "express" })],
      {
        installSdk: vi.fn(async (input: { cwd: string }) => {
          steps.push(`install:${input.cwd}`);
          return {
            installed: false,
            packages: ["crumbtrail-core", "crumbtrail-node"],
            note: "npm install failed (offline registry).",
          };
        }) as unknown as WizardDeps["installSdk"],
      },
    );
    const { ui, lines } = captureUi();
    deps.ui = ui;

    await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(out).not.toContain("already wired");
    expect(out).toContain("not wired");
    expect(out).toContain("crumbtrail-core, crumbtrail-node");
  });

  it("says what actually happened when the user declined the edit", async () => {
    const steps: string[] = [];
    const deps = batchDeps(
      steps,
      [candidate({ relDir: "apps/web", recipe: "next" })],
      {
        buildPlan: vi.fn((input: { cwd: string }) => {
          steps.push(`build:${input.cwd}`);
          return {
            ...createPlan(),
            kind: "needs-confirm-dirty" as const,
            targetPath: `${input.cwd}/src/main.ts`,
          };
        }) as unknown as WizardDeps["buildPlan"],
      },
    );
    // Decline the "prepend into a dirty file anyway?" question.
    deps.prompter = { ...deps.prompter, confirm: async () => false };
    const { ui, lines } = captureUi();
    deps.ui = ui;

    await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(out).not.toContain("already wired");
    expect(out).toContain("not wired");
  });

  it("does not mint a key for an already-wired service", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({
        relDir: "apps/admin",
        recipe: "next",
        flags: ["already-wired"],
        defaultChecked: false,
      }),
    ]);
    // Explicitly select BOTH, so we prove the skip is behavior, not just an
    // unchecked default.
    deps.prompter = {
      ...deps.prompter,
      multiSelect: async (_q, items) => items.map((_, i) => i),
    };
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    expect(steps).toContain("provision:web");
    expect(steps).not.toContain("provision:admin");
    expect(steps).not.toContain("install:/app/apps/admin");
    expect(lines.join("\n")).toContain("complete for this endpoint");
  });

  it("does not wait for a Tauri service in the cloud poll", async () => {
    const steps: string[] = [];
    const dir = "/app/apps/desktop";
    const deps = batchDeps(
      steps,
      [
        candidate({
          relDir: "apps/desktop",
          recipe: "tauri",
          detected: detectResult({ cwd: dir, recipe: "tauri" }),
        }),
      ],
      {
        buildPlan: vi.fn(() => ({
          recipe: "tauri" as const,
          kind: "create" as const,
          targetPath: `${dir}/src/main.ts`,
          content: "// tauri init",
          warnings: [],
        })) as unknown as WizardDeps["buildPlan"],
      },
    );
    const { ui, lines } = captureUi();
    deps.ui = ui;

    await runCli(["node", "cli"], deps);

    expect(steps).not.toContain("poll");
    expect(lines.join("\n")).toContain("stores events locally");
  });

  it("writes a guide file for an OTLP service and never spawns a package manager", async () => {
    const steps: string[] = [];
    const spawnFn = vi.fn(() => 0);
    const deps = batchDeps(
      steps,
      [
        candidate({
          relDir: "services/payments",
          recipe: "otlp",
          detected: detectResult({
            cwd: "/app/services/payments",
            recipe: "otlp",
            otlpStack: "rails",
            entryFile: null,
          }),
        }),
      ],
      {
        buildPlan: vi.fn((input: { cwd: string }) => {
          steps.push(`build:${input.cwd}`);
          return {
            recipe: "otlp" as const,
            kind: "otlp-guidance" as const,
            targetPath: null,
            content: null,
            snippet: "OTEL_EXPORTER_OTLP_ENDPOINT=…",
            agentPrompt: "wire up otlp",
            warnings: [],
          };
        }) as unknown as WizardDeps["buildPlan"],
        // The REAL installSdk, so an accidental spawn would be caught.
        installSdk: (input) =>
          realInstallSdk({
            ...input,
            spawnFn,
            fetchImpl: (async () => {
              throw new Error("no network");
            }) as unknown as typeof fetch,
          }),
      },
    );
    const written: (string | null)[] = [];
    deps.executePlan = vi.fn((plan: Plan) => {
      written.push(plan.targetPath);
      return {
        kind: plan.kind,
        written: [plan.targetPath as string],
        skipped: false,
        message: "Wrote 1 file(s).",
      };
    }) as unknown as WizardDeps["executePlan"];

    const code = await runCli(["node", "cli"], deps);
    // An OTLP service is never wired by this run: the guide file names a manual
    // exporter step, so the batch reports itself incomplete and exits non zero.
    expect(code).toBe(1);
    // otlp has no SDK packages — installSdk must early-return, not shell out.
    expect(spawnFn).not.toHaveBeenCalled();
    expect(written).toEqual(["/app/services/payments/CRUMBTRAIL-OTLP.md"]);
  });

  it("refuses to guess in CI without --only/--all, and honors them when given", async () => {
    const candidates = [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ];

    const ciSteps: string[] = [];
    const ci = batchDeps(ciSteps, candidates);
    ci.isTTY = false;
    const { ui, lines } = captureUi();
    ci.ui = ui;
    // The pre-existing non-TTY guard already forces --yes --project in CI; the
    // new failure mode is having no way to say WHICH services.
    expect(await runCli(["node", "cli", "--yes", "--project", "p1"], ci)).toBe(
      1,
    );
    expect(lines.join("\n")).toContain("--only");
    expect(ciSteps).not.toContain("login");

    // --only picks exactly one, with no prompt.
    const onlySteps: string[] = [];
    const only = batchDeps(onlySteps, candidates);
    only.isTTY = false;
    only.prompter = {
      ...only.prompter,
      multiSelect: vi.fn(async () => {
        throw new Error("must not prompt");
      }),
    };
    expect(
      await runCli(
        ["node", "cli", "--yes", "--project", "p1", "--only", "services/api"],
        only,
      ),
    ).toBe(0);
    expect(onlySteps).toContain("provision:api");
    expect(onlySteps).not.toContain("provision:web");

    // An unknown --only value is a user error, not a silent no-op.
    const badSteps: string[] = [];
    const bad = batchDeps(badSteps, candidates);
    const badUi = captureUi();
    bad.ui = badUi.ui;
    expect(await runCli(["node", "cli", "--only", "nope"], bad)).toBe(1);
    expect(badUi.lines.join("\n")).toContain("no such service");
  });

  // Defect class: `--all` wired a shared library, so the app that imports it
  // filed every session under the library's name and the real service reported
  // nothing.
  it("--all skips a library and names it, while --only still wires it", async () => {
    const candidates = [
      candidate({
        relDir: "packages/shared",
        recipe: "node",
        flags: ["likely-library"],
        defaultChecked: false,
      }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ];

    const steps: string[] = [];
    const deps = batchDeps(steps, candidates);
    deps.isTTY = false;
    const { ui, lines } = captureUi();
    deps.ui = ui;
    expect(
      await runCli(["node", "cli", "--yes", "--project", "p1", "--all"], deps),
    ).toBe(0);
    expect(steps).toContain("provision:api");
    expect(steps).not.toContain("provision:shared");
    expect(lines.join("\n")).toContain("packages/shared: nothing runs this package");

    // Named explicitly, it is still the user's call.
    const onlySteps: string[] = [];
    const only = batchDeps(onlySteps, candidates);
    only.isTTY = false;
    expect(
      await runCli(
        [
          "node",
          "cli",
          "--yes",
          "--project",
          "p1",
          "--only",
          "packages/shared",
        ],
        only,
      ),
    ).toBe(0);
    expect(onlySteps).toContain("provision:shared");
  });

  it("bails when nothing in the repo can be wired", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({
        relDir: "packages/tsconfig",
        recipe: null,
        selectable: false,
        defaultChecked: false,
        flags: ["no-recipe"],
      }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    expect(await runCli(["node", "cli"], deps)).toBe(1);
    expect(steps).not.toContain("login");
    expect(lines.join("\n")).toContain("Nothing in /app can be wired");
  });
});

describe("wizard — OTLP backend (non-JS)", () => {
  it("skips the SDK install (no spawn) and prints OTLP guidance, touching no files", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const spawnFn = vi.fn(() => 0);
    const executePlan = vi.fn(() => {
      steps.push("execute");
      return {
        kind: "otlp-guidance" as const,
        written: [],
        skipped: true,
        message: "OTLP",
      };
    }) as unknown as WizardDeps["executePlan"];
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: "otlp",
            otlpStack: "fastapi",
            entryFile: null,
            ambiguous: false,
            packageJsonPath: null,
          });
        }),
        // Exercise the REAL installSdk so the empty-package guard is under test.
        installSdk: (input) => {
          steps.push("install");
          return realInstallSdk({ ...input, spawnFn });
        },
        buildPlan: vi.fn(() => {
          steps.push("build");
          return {
            recipe: "otlp",
            kind: "otlp-guidance",
            targetPath: null,
            content: null,
            warnings: [],
            snippet:
              "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9999\nOTEL_EXPORTER_OTLP_HEADERS=X-Crumbtrail-Auth=bl_key",
            agentPrompt:
              "Agent: point OTEL_EXPORTER_OTLP_ENDPOINT at Crumbtrail",
          } as Plan;
        }) as unknown as WizardDeps["buildPlan"],
        executePlan,
      },
    );
    const code = await runCli(["node", "cli"], deps);
    // Guidance only: nothing was wired and the exporter step is still on the
    // reader, which the summary bar has always said and the exit code now says
    // too.
    expect(code).toBe(1);
    // The empty SDK package list must NOT spawn a package manager.
    expect(spawnFn).not.toHaveBeenCalled();
    // The guidance path never calls the executor (it prints, touches nothing).
    expect(executePlan).not.toHaveBeenCalled();
    const out = lines.join("\n");
    expect(out).toContain("OpenTelemetry");
    expect(out).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});

describe("wizard — detection-quality notes (CP6)", () => {
  it("prints a docker coming-soon note after '✓ Detected' without changing the flow", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({ notes: [DOCKER_COMING_SOON_NOTE] });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Detected a ");
    expect(out).toContain(DOCKER_COMING_SOON_NOTE);
  });

  it("surfaces a Deno-specific message (not the generic hint) on the no-recipe path", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: null,
            ambiguous: true,
            entryFile: null,
            packageJsonPath: null,
            reasons: [DENO_UNSUPPORTED_REASON],
          });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("Deno projects aren't supported yet");
    // The generic "Supported: ..." framework list is suppressed for Deno.
    expect(out).not.toContain("Supported: Next.js");
  });

  it("prints a docker note on the no-recipe path too", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: null,
            ambiguous: true,
            entryFile: null,
            reasons: ["no recipe matched"],
            notes: [DOCKER_COMING_SOON_NOTE],
          });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain(DOCKER_COMING_SOON_NOTE);
    expect(out).toContain("No supported framework in /app");
    expect(out).toContain("cd apps/web && npx crumbtrail");
    expect(out).toContain("cd <project folder> && npx crumbtrail");
  });
});

describe("non-TTY guard", () => {
  it("refuses without --yes AND --project", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps, isTTY: false }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    expect(steps).toEqual([]); // guarded before any step
    expect(lines.join("\n")).toContain("Non-interactive");
  });

  it("proceeds when given --yes and --project", async () => {
    const steps: string[] = [];
    const deps = makeDeps({ steps, isTTY: false });
    const code = await runCli(
      ["node", "cli", "--yes", "--project", "proj_1"],
      deps,
    );
    expect(code).toBe(0);
    expect(steps).toContain("provision");
  });
});

describe("non-TTY login fail-fast wiring (BUG-4)", () => {
  it("passes allowInteractiveLogin=false to ensureToken in a non-TTY shell", async () => {
    const steps: string[] = [];
    let seen: boolean | undefined;
    const deps = makeDeps(
      { steps, isTTY: false },
      {
        ensureToken: vi.fn(
          async (opts: { allowInteractiveLogin?: boolean }) => {
            seen = opts.allowInteractiveLogin;
            return "ctcli_token";
          },
        ) as unknown as WizardDeps["ensureToken"],
      },
    );
    // Non-TTY needs --yes --project to clear the prompt guard and reach login.
    const code = await runCli(
      ["node", "cli", "--yes", "--project", "p1"],
      deps,
    );
    expect(code).toBe(0);
    expect(seen).toBe(false);
  });

  it("passes allowInteractiveLogin=true in an interactive shell", async () => {
    const steps: string[] = [];
    let seen: boolean | undefined;
    const deps = makeDeps(
      { steps, isTTY: true },
      {
        ensureToken: vi.fn(
          async (opts: { allowInteractiveLogin?: boolean }) => {
            seen = opts.allowInteractiveLogin;
            return "ctcli_token";
          },
        ) as unknown as WizardDeps["ensureToken"],
      },
    );
    await runCli(["node", "cli"], deps);
    expect(seen).toBe(true);
  });
});

describe("wizard — --workspace targeting (BUG-6)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "bl-ws-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("points detection at the resolved package dir instead of the repo root", async () => {
    const wsDir = path.join(tmp, "apps", "web");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "web" }),
    );
    const steps: string[] = [];
    let detectedCwd: string | undefined;
    const deps = makeDeps(
      { steps },
      {
        cwd: tmp,
        detect: vi.fn((cwd: string) => {
          detectedCwd = cwd;
          steps.push("detect");
          return detectResult({ cwd });
        }),
      },
    );
    const code = await runCli(["node", "cli", "--workspace", "apps/web"], deps);
    expect(code).toBe(0);
    expect(detectedCwd).toBe(wsDir);
  });

  it("fails with a clear error when the --workspace dir is missing", async () => {
    const { ui, lines } = captureUi();
    const steps: string[] = [];
    const deps = makeDeps({ steps }, { cwd: tmp, ui });
    const code = await runCli(
      ["node", "cli", "--workspace", "apps/ghost"],
      deps,
    );
    expect(code).toBe(1);
    // Bailed before detection ever ran.
    expect(steps).not.toContain("detect");
    expect(lines.join("\n")).toMatch(/no such directory/);
  });

  it("fails when the --workspace dir has no package.json", async () => {
    mkdirSync(path.join(tmp, "services", "rails"), { recursive: true });
    const { ui, lines } = captureUi();
    const steps: string[] = [];
    const deps = makeDeps({ steps }, { cwd: tmp, ui });
    const code = await runCli(
      ["node", "cli", "--workspace", "services/rails"],
      deps,
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/no package\.json/);
  });
});

describe("wizard — dirty-file decline covers the complete local setup", () => {
  it("leaves SDK, package.json, env, and key untouched on a decline", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const confirm = vi.fn(async () => false);
    const envFileIO = fakeEnvIO();
    const deps = makeDeps(
      { steps },
      {
        ui,
        envFileIO,
        buildPlan: vi.fn(() => {
          steps.push("build");
          return {
            recipe: "vite-spa",
            kind: "needs-confirm-dirty",
            targetPath: "/app/src/main.ts",
            content: "// crumbtrail init snippet",
            warnings: [],
          } as Plan;
        }) as unknown as WizardDeps["buildPlan"],
        installSdk: vi.fn(async () => {
          steps.push("install");
          return { installed: true, packages: ["crumbtrail-core"] };
        }),
        prompter: { ...noopPrompter, confirm },
      },
    );
    const code = await runCli(["node", "cli"], deps);
    // Declining leaves the app unwired, which the summary calls "Setup
    // incomplete". The exit code says the same.
    expect(code).toBe(1);
    // The decline is asked before installSdk, so no local setup write runs.
    expect(steps).not.toContain("execute");
    expect(steps).not.toContain("install");
    expect(steps).not.toContain("mint-key");
    expect(envFileIO.files.size).toBe(0);
    const out = lines.join("\n");
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("No leaves all local files unchanged"),
      false,
    );
    expect(out).toMatch(/no ingest key was minted/i);
    expect(out).toMatch(/setup incomplete/i);
    // The prompt said "No leaves all local files unchanged" and nothing else,
    // while a project and an application had already been created in the
    // reader's dashboard. The cloud half is not undone by a No, so the question
    // has to name it before it is asked.
    expect(out).toMatch(/already created in your dashboard/i);
    expect(out).toMatch(/application web/i);
  });
});

describe("wizard — evidence-source onboarding pointer (BUG-14)", () => {
  it("prints the evidence-source pointer with the dashboard URL after verify", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Evidence sources:");
    expect(out).toContain("http://127.0.0.1:9999/p/p1/integrations");
    // Only adapters that actually exist may be named.
    for (const provider of [
      "Sentry",
      "CloudWatch",
      "Splunk",
      "Datadog",
      "PostHog",
      "Cloudflare",
    ]) {
      expect(out).toContain(provider);
    }
  });

  it("does not print the pointer when verification is skipped", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli", "--skip-verify"], deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("Evidence sources:");
  });
});

describe("isCliEntrypoint", () => {
  it("matches direct dist invocations and the npm bin symlink name", () => {
    expect(isCliEntrypoint("/x/dist/cli.cjs")).toBe(true);
    expect(isCliEntrypoint("/x/dist/cli.js")).toBe(true);
    expect(isCliEntrypoint("/x/dist/cli.mjs")).toBe(true);
    expect(isCliEntrypoint("/x/src/cli.ts")).toBe(true);
    // npm installs the bin as a symlink named after the bin key; Node does not
    // realpath argv[1], so the bare bin name must match.
    expect(isCliEntrypoint("/y/node_modules/.bin/crumbtrail")).toBe(true);
    expect(isCliEntrypoint("/usr/local/bin/crumbtrail")).toBe(true);
  });

  it("stays inert for test runners and unrelated scripts", () => {
    expect(isCliEntrypoint(undefined)).toBe(false);
    expect(isCliEntrypoint("")).toBe(false);
    expect(isCliEntrypoint("/x/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(isCliEntrypoint("/x/some-other-cli.cjs")).toBe(false);
    expect(isCliEntrypoint("/x/crumbtrail-server")).toBe(false);
  });
});

describe("installSdk — registry install is version pinned", () => {
  it("passes ^floor specs to the package manager, never bare names", async () => {
    const uiSink: Ui = { out: () => {}, err: () => {} };
    const calls: string[][] = [];
    const spawnFn = (_cmd: string, args: string[]) => {
      calls.push(args);
      return 0;
    };
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "npm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn,
    });
    expect(result.installed).toBe(true);
    // Bare names would let a stale dist tag resolve to an old 0.2.x SDK; a
    // floor must be applied to every package.
    expect(calls[0]).toEqual([
      "install",
      ...["crumbtrail-core", "crumbtrail-node"].map((pkg) =>
        sdkInstallSpecForCli(pkg),
      ),
    ]);
    // `>=`, not `^`: a caret on a 0.x version also caps at the next minor, which
    // would strand new installs on one minor line until the floor is bumped.
    for (const spec of calls[0].slice(1)) {
      expect(spec).toMatch(/^crumbtrail-(core|node)@>=\d+\.\d+\.\d+$/);
    }
    // The result reports bare package names (used for notes + tarball fallback).
    expect(result.packages).toEqual(["crumbtrail-core", "crumbtrail-node"]);
  });
});

describe("installSdk — a nonzero exit is not proof of a failed install", () => {
  const uiSink: Ui = { out: () => {}, err: () => {} };

  it("treats packages that are on disk as installed when the package manager exits nonzero", async () => {
    // pnpm 10+/11 exits 1 with ERR_PNPM_IGNORED_BUILDS whenever any dependency
    // has an unapproved build script (esbuild, sharp, prisma), long after the
    // requested packages are installed.
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "pnpm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn: () => 1,
      cliVersion: "0.37.0",
      resolvedVersionFn: () => "0.37.0",
    });
    expect(result.installed).toBe(true);
    expect(result.note).toContain("exited nonzero");
    expect(result.note).toContain("ERR_PNPM_IGNORED_BUILDS");
  });

  it("still fails when the packages really are absent", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "pnpm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn: () => 1,
      fetchImpl,
      cliVersion: "0.37.0",
      resolvedVersionFn: () => undefined,
    });
    expect(result.installed).toBe(false);
    expect(result.note).toContain("failed");
  });

  it("names release-age gating when the resolved SDK is older than the CLI", async () => {
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "pnpm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn: () => 0,
      cliVersion: "0.37.0",
      resolvedVersionFn: () => "0.36.0",
    });
    expect(result.installed).toBe(true);
    expect(result.note).toContain("minimumReleaseAge");
    // The exact way out, not just a diagnosis.
    expect(result.note).toContain("pnpm add crumbtrail-core@0.37.0");
  });

  it("says nothing when the resolved SDK matches the CLI", async () => {
    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "pnpm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn: () => 0,
      cliVersion: "0.37.0",
      resolvedVersionFn: () => "0.37.0",
    });
    expect(result).toEqual({
      installed: true,
      packages: ["crumbtrail-core", "crumbtrail-node"],
    });
  });
});

describe("SDK install floor follows the CLI's own version", () => {
  it("asks for at least the CLI's version, so a release-age gate cannot skip it", () => {
    expect(sdkInstallSpecForCli("crumbtrail-node", "0.37.0")).toBe(
      "crumbtrail-node@>=0.37.0",
    );
  });

  it("keeps the capability floor when the CLI is somehow older", () => {
    expect(sdkInstallSpecForCli("crumbtrail-node", "0.1.0")).toBe(
      sdkInstallSpec("crumbtrail-node"),
    );
  });

  it("does not demand a prerelease SDK from a prerelease CLI", () => {
    expect(sdkInstallSpecForCli("crumbtrail-node", "0.99.0-rc.1")).toBe(
      sdkInstallSpec("crumbtrail-node"),
    );
  });

  it("orders versions numerically, with a prerelease below its release", () => {
    expect(compareSdkVersions("0.37.0", "0.36.0")).toBe(1);
    expect(compareSdkVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSdkVersions("0.37.0-rc.1", "0.37.0")).toBe(-1);
    expect(compareSdkVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("floors every installer-managed package, never a bare name", () => {
    for (const pkg of [
      "crumbtrail-core",
      "crumbtrail-node",
      "crumbtrail-react-native",
      "crumbtrail-capacitor",
    ]) {
      expect(sdkInstallSpecForCli(pkg)).toMatch(/@>=\d+\.\d+\.\d+$/);
    }
  });
});

describe("a withheld wiring still hands over the snippet", () => {
  it("prints the paste-this snippet when the SDK install failed", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps: [] },
      {
        ui,
        installSdk: vi.fn(async () => ({
          installed: false,
          packages: ["crumbtrail-core"],
          note: "SDK install via pnpm failed.",
        })),
        buildPlan: vi.fn(() => ({
          recipe: "vite-spa",
          kind: "fallback-ai" as const,
          warnings: [],
          keyEnvVar: "VITE_CRUMBTRAIL_KEY",
          snippet:
            "Crumbtrail.init({ key: import.meta.env.VITE_CRUMBTRAIL_KEY })",
          agentPrompt: "Wire Crumbtrail into this app.",
        })) as unknown as WizardDeps["buildPlan"],
      },
    );
    await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(out).toContain("is not installed");
    // The compounding bail: this run returned before the branch that prints
    // the snippet, so the user who most needed it was the one who never saw it.
    expect(out).toContain("Crumbtrail.init({ key: import.meta.env");
    expect(out).toContain("Wire Crumbtrail into this app.");
  });
});

describe("dashboard link on a split-origin deployment", () => {
  afterEach(() => clearReportedAppBases());

  it("uses the origin the deployment reported, whatever the token source", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    // What the real ensureToken records from the deployment. The CLI token here
    // comes from the environment, so nothing was ever written to auth.json.
    rememberAppBase("http://127.0.0.1:9999", "http://127.0.0.1:19892");
    await runCli(["node", "cli"], deps);
    const out = lines.join("\n");
    expect(out).toContain("http://127.0.0.1:19892/p/p1/issues");
    expect(out).not.toContain("http://127.0.0.1:9999/p/p1/issues");
  });

  it("says the link is a guess when the deployment reported nothing", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    await runCli(["node", "cli"], deps);
    expect(lines.join("\n")).toContain("CRUMBTRAIL_APP_URL");
  });
});

describe("a word that is not a subcommand", () => {
  it("answers `crumbtrail setup` with the one line that fixes it", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    const code = await runCli(["node", "cli", "setup"], deps);
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("no `setup` subcommand");
    expect(out).toContain("npx crumbtrail");
    // Not thirty lines of help for a one-line problem.
    expect(out).not.toContain("--skip-verify");
  });

  it("still shows usage for an argument nobody could mean", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    expect(await runCli(["node", "cli", "--frobnicate"], deps)).toBe(1);
    expect(lines.join("\n")).toContain("Unknown argument");
  });

  it("refuses a flag whose value is another flag, instead of using it", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    // This used to set the project id to the literal "--yes" and carry on,
    // wiring a typo's worth of telemetry into whatever project that named.
    expect(await runCli(["node", "cli", "--project", "--yes"], deps)).toBe(1);
    expect(lines.join("\n")).toContain("--project requires a value");
  });

  it("refuses a trailing flag with no value, instead of throwing", async () => {
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps: [] }, { ui });
    // `--only` with nothing after it reached .toLowerCase() on undefined and
    // ended the run with an internal TypeError.
    expect(await runCli(["node", "cli", "--only"], deps)).toBe(1);
    expect(lines.join("\n")).toContain("--only requires a value");
  });

  it("recognizes the words people actually type", () => {
    expect(wizardAliasHint("init")).toContain("no `init` subcommand");
    expect(wizardAliasHint("Install")).toContain("no `install` subcommand");
    expect(wizardAliasHint("verify")).toBeUndefined();
  });
});

describe("crumbtrail token", () => {
  it("prints the cached CLI token on stdout, with the guidance on stderr", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bl-token-"));
    try {
      const env = {
        XDG_CONFIG_HOME: home,
        CRUMBTRAIL_BASE_URL: "https://cloud.example",
      };
      saveAuth(
        {
          token: "ctcli_" + "z".repeat(48),
          expiresAt: "2099-01-01T00:00:00Z",
          endpoint: "https://cloud.example",
        },
        env,
      );
      const out: string[] = [];
      const err: string[] = [];
      const steps: string[] = [];
      const deps = makeDeps(
        { steps },
        {
          env,
          ui: { out: (l = "") => out.push(l), err: (l = "") => err.push(l) },
        },
      );
      const code = await runCli(["node", "cli", "token"], deps);
      expect(code).toBe(0);
      // Pipeable: the value and nothing else.
      expect(out.join("\n").trim()).toBe("ctcli_" + "z".repeat(48));
      expect(err.join("\n")).toContain("CRUMBTRAIL_TOKEN");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses with the way out when nothing is cached for this endpoint", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bl-token-"));
    try {
      const err: string[] = [];
      const steps: string[] = [];
      const deps = makeDeps(
        { steps },
        {
          env: {
            XDG_CONFIG_HOME: home,
            CRUMBTRAIL_BASE_URL: "https://cloud.example",
          },
          ui: { out: () => {}, err: (l = "") => err.push(l) },
        },
      );
      const code = await runCli(["node", "cli", "token"], deps);
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/crumbtrail login/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("probeServiceKeys", () => {
  const fail = (reason: string) => ({
    ok: false as const,
    endpoint: "http://cloud.example",
    stages: [
      { stage: "auth" as const, status: "fail" as const, reason, ms: 1 },
    ],
  });
  const pass = {
    ok: true as const,
    endpoint: "http://cloud.example",
    stages: [
      { stage: "auth" as const, status: "pass" as const, reason: "", ms: 1 },
    ],
  };

  it("probes the key each service carries, not the first one it can find", async () => {
    // The shape that broke: one service's .env already held a dead legacy key,
    // so it was recorded first, and the wizard probed THAT instead of the key
    // it had just minted and written into the other eight.
    const probed: string[] = [];
    const verdicts = await probeServiceKeys(
      [
        {
          name: "legacy",
          write: {
            status: "already-set",
            varName: "CRUMBTRAIL_KEY",
            probeKey: "bgk_stale",
          },
          where: "apps/legacy/.env",
          mintUrl: "http://app.example/p/proj_1/setup",
        },
        {
          name: "web",
          write: { status: "written", probeKey: "ctkey_fresh" },
        },
        {
          name: "api",
          write: { status: "written", probeKey: "ctkey_fresh" },
        },
      ],
      async (key) => {
        probed.push(key);
        return key === "bgk_stale"
          ? fail("ingest key rejected: not accepted (HTTP 401)")
          : pass;
      },
    );

    // One probe per DISTINCT key: the fresh key is not re-probed per service.
    expect(probed).toEqual(["bgk_stale", "ctkey_fresh"]);
    // The rejection speaks only for the service holding the rejected key.
    expect(verdicts.get("legacy")?.ok).toBe(false);
    expect(verdicts.get("web")?.ok).toBe(true);
    expect(verdicts.get("api")?.ok).toBe(true);
  });

  it("names a leftover key as a leftover, not as a failed install", async () => {
    const verdicts = await probeServiceKeys(
      [
        {
          name: "legacy",
          write: {
            status: "already-set",
            varName: "CRUMBTRAIL_KEY",
            probeKey: "bgk_stale",
          },
          where: "apps/legacy/.env",
          mintUrl: "http://app.example/p/proj_1/setup",
        },
      ],
      async () => fail("ingest key rejected: not accepted (HTTP 401)"),
    );
    const verdict = verdicts.get("legacy");
    expect(verdict?.ok).toBe(false);
    const note = verdict && !verdict.ok ? verdict.note : "";
    expect(note).toContain("apps/legacy/.env");
    expect(note).toContain("CRUMBTRAIL_KEY");
    expect(note).toContain("http://app.example/p/proj_1/setup");
    // The install itself was fine, so it must not claim otherwise.
    expect(note).not.toContain("First-event wait skipped");
  });

  it("still calls a key this run wrote a failed install", async () => {
    const verdicts = await probeServiceKeys(
      [{ name: "web", write: { status: "written", probeKey: "ctkey_x" } }],
      async () => fail("ingest key rejected: not accepted (HTTP 401)"),
    );
    const verdict = verdicts.get("web");
    expect(verdict && !verdict.ok ? verdict.note : "").toContain(
      "First-event wait skipped",
    );
  });

  it("says nothing about a service with no key to probe", async () => {
    const verdicts = await probeServiceKeys(
      [{ name: "flutter", write: { status: "no-variable" } }],
      async () => {
        throw new Error("must not probe");
      },
    );
    expect(verdicts.size).toBe(0);
  });
});

// A run that took the hosted default in silence looked exactly like one the
// user had chosen. The endpoint is where every session, project and key ends
// up, so an interactive run states it and lets the user change it; Enter keeps
// the default, and anything that already stated an endpoint is not asked twice.
describe("endpoint confirmation", () => {
  function endpointDeps(over: Partial<WizardDeps>): WizardDeps {
    return makeDeps({ steps: [] }, { env: { DISPLAY: ":0" }, ...over });
  }

  it("asks which endpoint an interactive run sends to, defaulting to the hosted cloud", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const deps = endpointDeps({
      prompter: {
        ...noopPrompter,
        ask: async (q, d) => {
          asked.push([q, d]);
          return d ?? "";
        },
      },
    });
    await runCli(["node", "cli"], deps);
    const endpointAsk = asked.find(([q]) => q.includes("endpoint"));
    expect(endpointAsk?.[1]).toBe("https://api.crumbtrail.ai");
  });

  it("sends to the endpoint the user typed instead of the default", async () => {
    const { ui, lines } = captureUi();
    const bases: string[] = [];
    const ensureToken = vi.fn(async (opts: { base: string }) => {
      bases.push(opts.base);
      return "ctcli_token";
    });
    const deps = endpointDeps({
      ui,
      ensureToken: ensureToken as unknown as WizardDeps["ensureToken"],
      prompter: {
        ...noopPrompter,
        ask: async (q, d) =>
          q.includes("endpoint") ? "http://127.0.0.1:19890" : (d ?? ""),
      },
    });
    await runCli(["node", "cli"], deps);
    expect(bases).toEqual(["http://127.0.0.1:19890"]);
    expect(lines.join("\n")).toContain("http://127.0.0.1:19890");
  });

  it("does not ask when --endpoint already stated one", async () => {
    let asked = 0;
    const deps = endpointDeps({
      prompter: {
        ...noopPrompter,
        ask: async (q, d) => {
          if (q.includes("endpoint")) asked++;
          return d ?? "";
        },
      },
    });
    await runCli(["node", "cli", "--endpoint", "http://127.0.0.1:19890"], deps);
    expect(asked).toBe(0);
  });

  it("does not ask in a non-interactive shell or under --yes", async () => {
    let asked = 0;
    const prompter = {
      ...noopPrompter,
      ask: async (q: string, d?: string) => {
        if (q.includes("endpoint")) asked++;
        return d ?? "";
      },
    };
    await runCli(
      ["node", "cli"],
      makeDeps(
        { steps: [], isTTY: false },
        { env: { DISPLAY: ":0" }, prompter },
      ),
    );
    await runCli(["node", "cli", "--yes"], endpointDeps({ prompter }));
    expect(asked).toBe(0);
  });
});
