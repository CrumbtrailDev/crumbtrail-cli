import { describe, expect, it, vi } from "vitest";
import {
  createProject,
  inferProjectName,
  inferServiceName,
  listProjects,
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
        error: "The free tier includes one project. Upgrade to add more.",
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
