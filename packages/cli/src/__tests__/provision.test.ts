import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../net";
import {
  createIngestKey,
  createProject,
  createService,
  explainWrongAccount,
  inferProjectName,
  inferServiceName,
  listProjects,
  resolveProject,
  ProjectAccessError,
  UpgradeRequiredError,
} from "../provision";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function econnreset(): Error {
  const e = new Error("socket hang up");
  (e as Error & { code?: string }).code = "ECONNRESET";
  return e;
}

describe("inferProjectName", () => {
  it("prefers the package name, dropping a scope", () => {
    expect(inferProjectName("@acme/checkout", "repo")).toBe("checkout");
    expect(inferProjectName("myapp", "repo")).toBe("myapp");
  });
  it("falls back to the git dir basename, then a default", () => {
    expect(inferProjectName(null, "my-repo")).toBe("my-repo");
    expect(inferProjectName("", "  ")).toBe("my-app");
    expect(inferProjectName(undefined, undefined)).toBe("my-app");
  });
});

describe("inferServiceName", () => {
  it("uses a workspace name when present", () => {
    expect(inferServiceName("vite-spa", "@acme/web")).toBe("web");
  });
  it("defaults node→api and client→web", () => {
    expect(inferServiceName("node")).toBe("api");
    expect(inferServiceName("next")).toBe("web");
    expect(inferServiceName("sveltekit")).toBe("web");
  });
});

describe("createProject 402", () => {
  it("throws UpgradeRequiredError with copy + upgrade URL, no crash", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(402, {
        error: "Your plan's project limit was reached. Upgrade to add more.",
        code: "upgrade_required",
        upgradeUrl: "https://cloud.example/dashboard?upgrade=team",
      }),
    ) as unknown as typeof fetch;

    await expect(
      createProject("http://127.0.0.1:1", "bl_cli_x", "app", fetchImpl),
    ).rejects.toMatchObject({
      name: "UpgradeRequiredError",
      message: expect.stringContaining("Upgrade to add more"),
      upgradeUrl: "https://cloud.example/dashboard?upgrade=team",
    });
    // Exactly one attempt — a 402 is not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("single-retry on transient failure", () => {
  it("retries once on ECONNRESET then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw econnreset();
      return jsonResponse(200, { projects: [{ id: "p1", name: "app" }] });
    }) as unknown as typeof fetch;

    const projects = await listProjects(
      "http://127.0.0.1:1",
      "bl_cli_x",
      fetchImpl,
    );
    expect(projects).toEqual([{ id: "p1", name: "app" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a NetworkError (with method+URL) when both attempts fail", async () => {
    const fetchImpl = vi.fn(async () => {
      throw econnreset();
    }) as unknown as typeof fetch;
    await expect(
      listProjects("http://127.0.0.1:9/base", "bl_cli_x", fetchImpl),
    ).rejects.toThrow(/GET http:\/\/127\.0\.0\.1:9\/base\/api\/projects/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("resolveProject with --project", () => {
  const deps = () => {
    const lines: string[] = [];
    return {
      base: "https://api.example.dev",
      token: "t",
      ui: {
        out: (line?: string) => {
          lines.push(line ?? "");
        },
        err: (line?: string) => {
          lines.push(line ?? "");
        },
        status: () => {},
      },
      prompter: {
        select: (): never => {
          throw new Error("must not prompt in these cases");
        },
        ask: (): never => {
          throw new Error("must not prompt in these cases");
        },
        confirm: (): never => {
          throw new Error("must not prompt in these cases");
        },
        multiSelect: (): never => {
          throw new Error("must not prompt in these cases");
        },
      },
      assumeYes: true,
      defaultProjectName: "inferred",
      lines,
    };
  };

  it("names the project rather than printing its id", async () => {
    // The dashboard wizard passes --project when it is adding an app to a
    // project the reader is already looking at. Echoing `prj_7f3a` back under
    // a "Project:" label agrees with nothing they have seen.
    const d = deps();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        projects: [
          { id: "prj_7f3a", name: "Checkout", createdAt: "" },
          { id: "prj_other", name: "Other", createdAt: "" },
        ],
      }),
    );

    const project = await resolveProject({
      ...d,
      projectId: "prj_7f3a",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    } as Parameters<typeof resolveProject>[0]);

    expect(project).toEqual({ id: "prj_7f3a", name: "Checkout" });
    expect(d.lines.join("\n")).toContain("Checkout");
  });

  it("refuses a --project this account cannot see, naming the account", async () => {
    const d = deps();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        projects: [{ id: "prj_mine", name: "Mine", createdAt: "" }],
      }),
    );

    let thrown: unknown;
    try {
      await resolveProject({
        ...d,
        projectId: "prj_theirs",
        identityLabel: "someone@example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      } as Parameters<typeof resolveProject>[0]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      name: "ProjectAccessError",
      message: expect.stringMatching(
        /signed in as someone@example.com cannot see project prj_theirs/,
      ),
    });
    expect((thrown as Error).message).toContain("crumbtrail logout");
    expect(d.lines.join("\n")).not.toContain("Project:");
    expect(d.lines.join("\n")).not.toMatch(/Project not found/i);
  });

  it("joins a project that already carries the inferred name under --yes", async () => {
    // An unattended second run in the same app infers the same name again.
    // Creating a second project under it split the app's sessions across two
    // identical looking rows, and neither one held the whole story.
    const d = deps();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        projects: [{ id: "prj_existing", name: "Inferred", createdAt: "" }],
      }),
    );

    const project = await resolveProject({
      ...d,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    } as Parameters<typeof resolveProject>[0]);

    // Matched ignoring case: the two names are indistinguishable to whoever
    // would have to pick between them.
    expect(project).toEqual({
      id: "prj_existing",
      name: "Inferred",
      createdAt: "",
    });
    // And nothing was created.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the id when the list cannot be read", async () => {
    const d = deps();
    const fetchImpl = vi.fn(async () => {
      throw econnreset();
    });

    const project = await resolveProject({
      ...d,
      projectId: "prj_7f3a",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    } as Parameters<typeof resolveProject>[0]);

    // Still true, just less useful. Naming the project is not worth failing a
    // run that is otherwise fine.
    expect(project).toEqual({ id: "prj_7f3a", name: "prj_7f3a" });
  });
});

describe("resolveProject interactive default", () => {
  /** Records what the picker was offered and answers with `pick`. */
  function prompterThatPicks(pick: number) {
    const seen: { labels: string[]; def?: number } = { labels: [] };
    return {
      seen,
      prompter: {
        ask: vi.fn(async (_q: string, def?: string) => def ?? ""),
        confirm: vi.fn(async () => true),
        select: vi.fn(async (_q: string, labels: string[], def?: number) => {
          seen.labels = labels;
          seen.def = def;
          return pick;
        }),
        multiselect: vi.fn(async () => []),
        close: vi.fn(),
      } as unknown as Parameters<typeof resolveProject>[0]["prompter"],
    };
  }

  const ui = {
    out: vi.fn(),
    err: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
    ok: vi.fn(),
  } as unknown as Parameters<typeof resolveProject>[0]["ui"];

  function listing(projects: Array<{ id: string; name: string }>) {
    return vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/api/projects"))
        return jsonResponse(200, { projects });
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
  }

  it("defaults to a new project when nothing ties the repo to an existing one", async () => {
    const { seen, prompter } = prompterThatPicks(0);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST")
        return jsonResponse(200, { id: "p2", name: "checkout" });
      if (String(url).includes("/api/projects"))
        return jsonResponse(200, { projects: [{ id: "p1", name: "Acme" }] });
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const project = await resolveProject({
      base: "http://127.0.0.1:1",
      token: "bl_cli_x",
      ui,
      prompter,
      assumeYes: false,
      defaultProjectName: "checkout",
      fetchImpl,
    });
    // A blind Enter must not file this repo's telemetry into somebody else's
    // project: the default row creates a project named after this repo.
    expect(seen.labels[0]).toContain("Create a new project (checkout)");
    expect(seen.labels[1]).toBe("Acme");
    expect(seen.def).toBe(0);
    expect(project).toMatchObject({ id: "p2", name: "checkout" });
  });

  it("defaults to the existing project whose name matches this repo", async () => {
    const { seen, prompter } = prompterThatPicks(1);
    const project = await resolveProject({
      base: "http://127.0.0.1:1",
      token: "bl_cli_x",
      ui,
      prompter,
      assumeYes: false,
      defaultProjectName: "Checkout",
      fetchImpl: listing([
        { id: "p1", name: "Acme" },
        { id: "p2", name: "checkout" },
      ]),
    });
    // The name match is the one signal that the repo already maps to a
    // project, so joining it is the safe blind answer and leads the list.
    expect(seen.def).toBe(1);
    expect(seen.labels[2]).toContain("Create a new project");
    expect(project).toMatchObject({ id: "p2", name: "checkout" });
  });

  it("still joins an existing project when the reader picks its row", async () => {
    const { prompter } = prompterThatPicks(1);
    const project = await resolveProject({
      base: "http://127.0.0.1:1",
      token: "bl_cli_x",
      ui,
      prompter,
      assumeYes: false,
      defaultProjectName: "checkout",
      fetchImpl: listing([{ id: "p1", name: "Acme" }]),
    });
    expect(project).toMatchObject({ id: "p1", name: "Acme" });
  });

  it("creates one when the reader picks the create row", async () => {
    const { prompter } = prompterThatPicks(0);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST")
        return jsonResponse(200, { id: "p2", name: "checkout" });
      if (String(url).includes("/api/projects"))
        return jsonResponse(200, { projects: [{ id: "p1", name: "Acme" }] });
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const project = await resolveProject({
      base: "http://127.0.0.1:1",
      token: "bl_cli_x",
      ui,
      prompter,
      assumeYes: false,
      defaultProjectName: "checkout",
      fetchImpl,
    });
    expect(project).toMatchObject({ id: "p2", name: "checkout" });
  });
});

describe("createService on a name that is already taken", () => {
  it("adopts the existing service instead of failing the run", async () => {
    // The second `npx crumbtrail` in a wired app: the cloud refuses the name
    // (unique per project, ignoring case) and the run used to exit 1 before it
    // ever reached its own already-wired check.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: unknown) => {
      const method = ((init as { method?: string })?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${String(url)}`);
      if (method === "POST") {
        return jsonResponse(409, {
          error:
            "This project already has a service named web. Service names are unique within a project, ignoring case.",
          code: "service_name_taken",
          conflicts: ["web"],
        });
      }
      return jsonResponse(200, {
        services: [{ id: "svc_1", name: "Web" }],
      });
    }) as unknown as typeof fetch;

    const service = await createService(
      "https://cloud.example",
      "bl_cli_x",
      "prj_1",
      { name: "web", stack: "react" },
      fetchImpl,
    );
    expect(service).toMatchObject({ id: "svc_1", name: "Web", adopted: true });
    expect(calls).toEqual([
      "POST https://cloud.example/api/projects/prj_1/services",
      "GET https://cloud.example/api/projects/prj_1/services",
    ]);
  });

  it("re-throws when nothing in the project actually carries that name", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const method = ((init as { method?: string })?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return jsonResponse(409, {
          error: "This project already has a service named web.",
          code: "service_name_taken",
        });
      }
      return jsonResponse(200, { services: [{ id: "svc_2", name: "api" }] });
    }) as unknown as typeof fetch;

    await expect(
      createService(
        "https://cloud.example",
        "bl_cli_x",
        "prj_1",
        { name: "web" },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("explainWrongAccount", () => {
  it("turns the cloud's 404 into an account problem, naming the account", () => {
    const err = new ApiError("Project not found (POST /services) [404]", {
      status: 404,
    });
    const rewritten = explainWrongAccount(
      err,
      "prj_9fd0",
      "someone@example.com",
    );
    expect(String((rewritten as Error).message)).toContain(
      "signed in as someone@example.com cannot see project prj_9fd0",
    );
    expect(String((rewritten as Error).message)).toContain("crumbtrail logout");
    expect(String((rewritten as Error).message)).not.toMatch(/Project not found/i);
  });

  it("says the project is missing when a 404 has no signed in account to name", () => {
    const err = new ApiError("Project not found (POST /keys) [404]", {
      status: 404,
    });
    const rewritten = explainWrongAccount(err, "prj_1");
    expect(String((rewritten as Error).message)).toBe(
      "No project prj_1 exists. Check the id.",
    );
  });

  it("recognizes a forbidden project route as an account problem too", () => {
    const err = new ApiError("Forbidden (POST /keys) [403]", { status: 403 });
    const rewritten = explainWrongAccount(
      err,
      "prj_9fd0",
      "someone@example.com",
    );
    expect(rewritten).toBeInstanceOf(ProjectAccessError);
    expect(String((rewritten as Error).message)).toContain(
      "cannot see project",
    );
  });

  it("rewrites key minting access failures with the same account guidance", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: "Project not found" }),
    ) as unknown as typeof fetch;

    await expect(
      createIngestKey(
        "https://cloud.example",
        "bl_cli_x",
        "prj_9fd0",
        fetchImpl,
        "someone@example.com",
      ),
    ).rejects.toMatchObject({
      name: "ProjectAccessError",
      message: expect.stringContaining("crumbtrail logout"),
    });
  });

  it("leaves every other failure exactly as it was", () => {
    const err = new ApiError("boom", { status: 500 });
    expect(explainWrongAccount(err, "prj_1", "someone@example.com")).toBe(err);
  });
});

describe("createIngestKey 404", () => {
  it("reports a missing project rather than echoing Project not found", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: "Project not found", code: "not_found" }),
    ) as unknown as typeof fetch;

    await expect(
      createIngestKey("https://cloud.example", "bl_cli_x", "prj_gone", fetchImpl),
    ).rejects.toThrow("No project prj_gone exists. Check the id.");
  });
});
