# crumbtrail

The setup wizard for [Crumbtrail](https://crumbtrail.ai). It finds your app, wires
in the SDK, and confirms the first event actually arrives — so you don't have to
read an integration guide to get started.

```bash
npx crumbtrail
```

That's the whole install. There's nothing to add to `package.json` first.

## What it does

Running `npx crumbtrail` walks the full path in one pass:

1. **Detects** your stack — Next.js, Vite, React, Vue, Svelte, Express, Hono, Node,
   phone apps (React Native, Expo, Capacitor, Ionic, Flutter), and non-JS services
   like Django, Rails, Go and .NET.
2. **Logs you in** (opens a browser, or use `--no-browser` for a device code).
3. **Provisions** a project and service, mints the project's ingest key, and
   writes it into your app's env file — see "What it writes" for the rules that
   write follows, and `--no-write-key` to opt out.
4. **Installs** the right SDK package and **injects** the setup code into your entry
   file. This is the only step that writes to your repo, and it always runs last.
5. **Verifies** the wiring end to end, then waits for your first real event.

In a monorepo, run it from the repo root: it scans every workspace and service,
shows you what it found, and wires the ones you pick.

## Usage

```
crumbtrail [options]        Run the setup wizard (detect → login → wire → verify)
crumbtrail login           Log in and cache a token, nothing else
crumbtrail logout          Delete the cached token
crumbtrail verify          Preflight an endpoint + key (DNS, TLS, auth) — PASS/FAIL
```

| Option              | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `--yes`, `-y`       | Skip confirmations (required with `--project` in CI)           |
| `--project <id>`    | Attach to an existing project instead of creating one          |
| `--only <name>`     | Monorepo: wire only this service (repeatable)                  |
| `--all`             | Monorepo: wire every service it can, no prompts                |
| `--workspace <dir>` | Wire just one package dir instead of the whole repo            |
| `--no-browser`      | Use the device-code login flow                                 |
| `--skip-verify`     | Don't wait for the first event                                 |
| `--no-write-key`    | Don't mint or write a key; print the variable to set instead   |
| `--endpoint <url>`  | Cloud endpoint (else `$CRUMBTRAIL_BASE_URL`, else the default) |
| `--version`, `-v`   | Print the version                                              |

### Non-interactive / CI

Outside a TTY the wizard refuses to guess. Pass `--yes` and an existing
`--project <id>`:

```bash
npx crumbtrail --yes --project prj_1234abcd --only web --skip-verify
```

`--yes` without `--project` infers a project name from the app and uses the
project already carrying that name, ignoring case, rather than creating a
second one under it. Nothing already carrying that name means it is created.

## Verify your setup / pre-deploy check

`crumbtrail verify` runs a fast **synthetic preflight** against any environment's
endpoint and key and returns PASS/FAIL in a few seconds — point it at prod from
your laptop or CI _before_ you deploy, to catch a wrong key, wrong endpoint, or a
TLS cert/host mismatch that would otherwise leave you silently sending nothing.

```bash
crumbtrail verify --endpoint https://api.crumbtrail.ai --key <ingestKey>
```

It runs three staged checks, each reporting PASS/FAIL with the exact reason and
elapsed time:

1. **DNS** — the endpoint host resolves.
2. **TLS** — the certificate is actually valid _for that host_ (this is what
   catches a `*.up.railway.app`-style cert/host mismatch).
3. **Auth** — a real authenticated round-trip on the same path the SDK uses. A
   `200` passes; `401`/`403` means a bad or expired key; `404` means the wrong
   endpoint or path. The probe uses a synthetic `cli-check-` session the cloud
   recognizes and refuses to persist, so it never creates a dashboard session.

Unlike the setup wizard's verify step, this does **not** wait for live traffic —
it actively probes the config. It is non-interactive (no prompts, no browser), so
it is safe to run in CI.

| Option              | Description                                                                    |
| ------------------- | ------------------------------------------------------------------------------ |
| `--endpoint <url>`  | Endpoint to probe (else `$CRUMBTRAIL_BASE_URL`, else the default)              |
| `--key <ingestKey>` | Ingest key to probe with (else `$CRUMBTRAIL_KEY`, else the cached login token) |
| `--project <id>`    | Project id for the authenticated GET fallback when no key is given             |
| `--json`            | Emit a machine-readable result (`{ ok, endpoint, stages[] }`) for CI           |

The exit code is **`0` when every runnable stage passes and non-zero on any
failure**, so it drops straight into a CI gate:

```bash
crumbtrail verify --endpoint "$CRUMBTRAIL_BASE_URL" --key "$CRUMBTRAIL_KEY" --json \
  || { echo "Crumbtrail preflight failed — not deploying"; exit 1; }
```

### Pre-deploy CI gate

Run `verify` in your deploy pipeline to **confirm prod ingest works before you
ship, instead of deploy-and-pray**. Because a broken config (wrong key, wrong
endpoint, TLS cert/host mismatch) makes the preflight exit non-zero, the step —
and the whole job — fails, and the deploy never runs.

**GitHub Actions** — use the reusable composite action published from this repo,
so every consumer references one shared gate instead of forking a snippet:

```yaml
- name: Verify Crumbtrail config
  uses: CrumbtrailDev/crumbtrail-cli/.github/actions/verify@main
  with:
    endpoint: https://api.crumbtrail.ai
    key: ${{ secrets.CRUMBTRAIL_INGEST_KEY }}
    # project: prj_1234abcd    # optional
    # version: 0.5.0           # pin once released; default is `latest`

- name: Deploy
  run: ./deploy.sh
```

If the preflight fails, the verify step fails and `Deploy` never runs. See
[`.github/actions/verify`](../../.github/actions/verify) for the full input
reference.

**Any other CI (raw `npx`)** — the composite action is just a wrapper around the
published CLI, so non-GitHub pipelines get the same gate directly:

```bash
npx --yes crumbtrail@latest verify \
  --endpoint https://api.crumbtrail.ai \
  --key "$CRUMBTRAIL_INGEST_KEY" \
  --json \
  || { echo "Crumbtrail preflight failed — not deploying"; exit 1; }
```

`--json` emits `{ ok, endpoint, stages[] }` for machine parsing; the exit code
alone is enough to gate the pipeline.

**The key must come from a CI secret, never inline.** Store it as
`CRUMBTRAIL_INGEST_KEY` (or your secret name of choice) and reference it — the
CLI and the composite action never echo the key.

## What it writes

Two kinds of change, in the package it's wiring:

- the SDK import and `Crumbtrail.init(...)` call in your entry file
- for a Flutter app, the import plus an awaited `Crumbtrail.start(...)` as the
  first statement of `main()` (capture has to be running before the first frame)
- your ingest key, in an env file, plus a `.gitignore` entry for that file

It writes none of it when the SDK could not be installed. An import for a package
that is not there does not degrade, it fails the build, so a failed install ends
with your repository untouched and a note saying what to install.

Flutter is in that state right now: `crumbtrail_flutter` is not on pub.dev yet,
so a Flutter app is detected and reported but not wired. See
[`packages/flutter`](../flutter) for depending on it from source in the meantime.

The injected code reads the key from a framework-appropriate environment
variable — `NEXT_PUBLIC_CRUMBTRAIL_KEY` (Next), `VITE_CRUMBTRAIL_KEY` (Vite /
SvelteKit / Nuxt / Remix), `PUBLIC_CRUMBTRAIL_KEY` (Astro),
`EXPO_PUBLIC_CRUMBTRAIL_KEY` (Expo / React Native), or `CRUMBTRAIL_KEY` (Node
backends) — and the wizard mints the key and sets that variable for you.

Writing a live credential to disk follows four rules, and the wizard tells you
which one applied:

- **It never writes into a file git already tracks.** Adding that file to
  `.gitignore` afterwards would not untrack it, so the next commit would
  publish the key. In that case nothing is minted and the wizard hands the
  variable back to you.
- **It excludes the file it writes.** An env file that isn't ignored yet gets a
  `.gitignore` entry in the same step, so a live key is never one `git add .`
  from being committed.
- **It never overwrites a variable that already has a value.** A rerun against
  a configured app leaves your key exactly where it is.
- **It reuses one key per project.** A monorepo of nine services shares one
  credential rather than accumulating nine.

An existing `.env.local` or `.env` is used before a new file is created. With
neither present, a bundled variable goes to `.env.local` and a server variable
to `.env`, created `0600`. The key value is never printed to your terminal.

Pass `--no-write-key` to skip all of this and set the variable yourself, which
is the right choice when your secrets come from a vault or your platform's own
environment UI.

Flutter is the one exception to the `.env` part, because Dart has no runtime
environment to read on a phone. The injected code reads the key at compile time,
so you pass it to the build instead:

```bash
flutter run --dart-define=CRUMBTRAIL_KEY=<your-ingest-key>
```

It won't touch a package that is already wired, and it never edits libraries or
config-only packages.

## Prefer to wire it by hand?

Nothing here is magic — see [`crumbtrail-core`](https://www.npmjs.com/package/crumbtrail-core)
for the three-line manual setup.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Pricing** — https://crumbtrail.ai/pricing
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

PolyForm Shield 1.0.0. Free to use, read, modify and run, including inside a
commercial business. The one thing it stops is using the installer to build a
product that competes with Crumbtrail. See [LICENSE](LICENSE).

The SDKs it installs are MIT, so nothing the installer puts into your
application carries any restriction.
