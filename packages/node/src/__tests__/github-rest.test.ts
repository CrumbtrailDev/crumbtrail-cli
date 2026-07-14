import { describe, expect, it, vi } from "vitest";
import { GitHubRestClient, GitHostError } from "../git-host/github-rest";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("GitHubRestClient", () => {
  it("lists commits from the compare API, mapping sha/message/files", async () => {
    const payload = {
      commits: [
        {
          sha: "sha1",
          commit: { message: "first commit" },
          files: [{ filename: "src/routes/checkout.ts" }],
        },
        {
          sha: "sha2",
          commit: { message: "second commit" },
        },
      ],
    };
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(payload),
    );

    const client = new GitHubRestClient({
      owner: "acme",
      repo: "widgets",
      token: "tok-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const commits = await client.listCommits({
      baseRef: "v1",
      headRef: "v2",
    });

    expect(commits).toEqual([
      {
        sha: "sha1",
        message: "first commit",
        pr: undefined,
        files: ["src/routes/checkout.ts"],
      },
      {
        sha: "sha2",
        message: "second commit",
        pr: undefined,
        files: [],
      },
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("v1...v2");
    expect(String(url)).toContain("acme");
    expect(String(url)).toContain("widgets");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok-123",
    });
  });

  it("throws a typed GitHostError with status on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Not Found" }, 404),
    );

    const client = new GitHubRestClient({
      owner: "acme",
      repo: "widgets",
      token: "tok-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.listCommits({ baseRef: "v1", headRef: "v2" }),
    ).rejects.toMatchObject({ status: 404 });

    try {
      await client.listCommits({ baseRef: "v1", headRef: "v2" });
      throw new Error("expected listCommits to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHostError);
    }
  });
});
