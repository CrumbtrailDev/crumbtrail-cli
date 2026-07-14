# Git host setup for intent-inference

`solveContext` can correlate regression evidence to recent commits so
intentional changes are downranked as `intentional-change` instead of chased
as regressions (the anti-overfit split). This requires read access to the
repo's commit history via the GitHub REST API.

## What to provision

- A GitHub App install, or a fine-grained Personal Access Token, scoped to
  **`contents:read`** on the target repo. No write access is needed.
- Nothing else — Crumbtrail only calls the compare-commits endpoint
  (`GET /repos/{owner}/{repo}/compare/{base}...{head}`).

## How the token reaches the engine

Set the token as the `CRUMBTRAIL_GITHUB_TOKEN` environment variable in the
environment running `crumbtrail-node` / the MCP server:

```bash
export CRUMBTRAIL_GITHUB_TOKEN="<fine-grained PAT or App installation token>"
```

- Never commit this token to source control.
- Never pass it as a `solveContext` tool argument — the tool only accepts
  `gitHost: { owner, repo, baseRef, headRef }`; the token is read exclusively
  from the environment, at the boundary.

## Without a token

If `CRUMBTRAIL_GITHUB_TOKEN` is unset, or `gitHost` isn't passed, intent
inference is simply skipped. `solveContext` still returns full evidence and
hypotheses — the engine never fails the tool call for a missing token. The
only difference is that behavior changes explained by an intentional commit
won't be downranked out of `regression`.
