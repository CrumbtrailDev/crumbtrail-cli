# Local dev harness

Run the SDK and a target app together, so an SDK edit is visible to the running
app in about a second instead of an install cycle.

```bash
pnpm dev:harness                       # both default targets + capture server
pnpm dev:harness --target ../my-app    # any local app that installs the SDK
pnpm dev:harness --no-server           # watchers + linking only
```

Ctrl-C stops everything and restores every target to packed mode.

## What it does

1. Builds the SDK packages once, if `dist/` is missing.
2. Repoints each target's installed `crumbtrail-*` to this checkout.
3. Runs `tsup --watch` on `core`, `node`, and `react`.
4. Starts the capture server and waits for `/health` before reporting it up.

Process logs land in `.harness-logs/` (gitignored), one file per process.

## Linking, separately

```bash
pnpm dev:status --target ../crumbtrail-playground   # PACKED / LINKED / MIXED
pnpm dev:link   --target ../crumbtrail-playground
pnpm dev:unlink --target ../crumbtrail-playground
```

Linking swaps the leaf symlink inside the target's `node_modules`. It does not
touch the target's `package.json` or lockfile, so the target repo stays clean in
git, and `pnpm install` there undoes it even if the harness died mid-run. The
original symlink targets are recorded in `.crumbtrail-harness-links.json` at the
target root and removed on unlink.

## Linked mode does not prove packaging

A symlink bypasses `files`, the exports map, and `prepack` — so a package that is
broken **as a tarball** still works when linked. Linked mode is for iteration
only. Gate on the packed path:

```bash
cd ../crumbtrail-playground
pnpm playground:refresh-vendor --from ../crumbtrail-cli
pnpm playground:verify --all --json
```

Run `pnpm dev:unlink` first — re-vendoring while linked pins tarballs whose
contents were never the thing you tested.
