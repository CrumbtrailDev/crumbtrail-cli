import type { CommitInfo, GitHostClient, GitHostRef } from "crumbtrail-core";

export interface GitHubRestClientConfig {
  owner: string;
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** Thrown when the GitHub REST API responds with a non-2xx status. */
export class GitHostError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHostError";
    this.status = status;
  }
}

interface GitHubCompareCommitFile {
  filename: string;
}

interface GitHubCompareCommit {
  sha: string;
  commit: { message: string };
  files?: GitHubCompareCommitFile[];
}

interface GitHubComparePayload {
  commits: GitHubCompareCommit[];
  files?: GitHubCompareCommitFile[];
}

/** `GitHostClient` implementation over the GitHub REST compare API. Fetch is injected for testability. */
export class GitHubRestClient implements GitHostClient {
  private owner: string;
  private repo: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(config: GitHubRestClientConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async listCommits(ref: GitHostRef): Promise<CommitInfo[]> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/compare/${ref.baseRef}...${ref.headRef}`;
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      throw new GitHostError(
        res.status,
        `GitHub compare request failed with HTTP ${res.status}`,
      );
    }

    const payload = (await res.json()) as GitHubComparePayload;
    return (payload.commits ?? []).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      pr: undefined,
      files: (c.files ?? payload.files ?? []).map((f) => f.filename),
    }));
  }
}
