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
shows you what it found, and wires the ones you pick. The root package is in
that list when it is itself a runnable app, which is the common layout of an API
at the repo root with the web app as a workspace under it.

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

A saved login is reused only for the endpoint it was minted against. If `--project` names a project that account cannot see, the wizard names the signed in account and tells you to run `crumbtrail logout`.

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

Three kinds of change, in the package it's wiring:

- the SDK import and `Crumbtrail.init(...)` call in your entry file
- for a Flutter app, the import plus an awaited `Crumbtrail.start(...)` as the
  first statement of `main()` (capture has to be running before the first frame)
- your ingest key, in an env file, plus a `.gitignore` entry for that file
- the same setup code in every **other process the package starts**, and the
  build argument a **containerised frontend** needs — see
  [Everything a deployed app needs](#everything-a-deployed-app-needs)

Browser inits also carry a `networkCorrelationAllowedOrigins` list, filled in
with the backend origins the repository names: the targets of the app's own dev
server proxy, absolute API base URLs in its env files, and the local origins of
backend services being wired in the same run. The wizard prints which origins it
enabled. When the repository names none it emits the list empty, with a comment
saying what belongs in it, and you fill it in yourself. See
[If your frontend and backend are separate services](#if-your-frontend-and-backend-are-separate-services).

### What it turns off

The SDK's own defaults capture more than a first install should, and
`PRESET_PASSIVE` does not change that: it sets two auto flag booleans and turns
nothing off. An init that names no collectors therefore ships cookie values,
every keystroke and every clipboard read on the first deploy. The wizard writes
three opt outs into every browser init instead, where you can see them and
change them:

```js
cookies: false,
keystrokes: false,
clipboard: false,
```

Set one to `true` when your privacy notice covers it. Everything else stays on.
Console, network, clicks, storage, errors and performance are what a bug is
read from, and an install that captured none of them would report success and
tell you nothing.

Backends get two more. `autoCapture` is wrapped in a check on the ingest key,
because it hooks uncaught exceptions and patches your SQL driver before its
first handshake, so a service that was never given a key would otherwise pay all
of that and capture nothing. On Express, both middleware are written with
`captureResponseBody: "off"`, because a 4xx body is an auth or validation
payload belonging to your own user, and the request middleware also gets
`captureLogs: false` and `captureRuntimeWarnings: false`, because `autoCapture`
already captures both in the same process and the middleware would only patch
stdout a second time. Set `captureResponseBody` to `"error"` or `"all"` when you
want the response text that explains a failure.

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

It won't touch a package whose reachable Crumbtrail setup already matches the
target endpoint, has a configured ingest key and service name, and enables
remote configuration where the SDK supports it. When an SDK is present but
the setup is incomplete, the wizard names what is missing and does not add a
second initialization. It never edits libraries or configuration only packages.

## Everything a deployed app needs

An app is more than its entry file, and wiring only the entry leaves gaps that
report success and capture nothing. The wizard closes three of them, and names
each edit it makes.

**Your key is read after your `.env` is loaded.** Every backend entry gets a
short guarded loader above the setup code, so `CRUMBTRAIL_KEY` is set before
anything reads it. Without it a key that lives in `.env` rather than in the real
environment is missing at the moment it is needed, so capture is off on a laptop
and on in production. That is the wrong way round: the laptop is where someone
is reproducing the bug. The loader fills the variable in only when it is absent,
so a real environment variable always wins.

**Every process your package starts is wired, not just the one that serves
HTTP.** The wizard reads your `package.json` scripts, and any other runnable
file they start — a queue consumer, a scheduler, a batch worker — is wired too,
each reporting under its own service name (`your-app` and `your-app-worker`).
Those processes run unattended, which is exactly why their failures are worth
capturing. Config files, tests and build scripts are left alone, and a file with
uncommitted changes is reported rather than edited.

**A containerised frontend gets its key declared as a build argument.** Vite,
Next, Astro and Expo bake their public variables into the bundle when it is
built, and a Docker build cannot see a variable the Dockerfile has not declared
with `ARG`. A Dockerfile that lists every other `VITE_*` and not this one builds
an image that can never carry a key, and nothing about the build fails to say
so. The wizard adds the missing `ARG` (and its `ENV` mirror, if the siblings use
one) next to those siblings, in the stage that runs the build. When the
Dockerfile passes no build arguments at all, where the line belongs is a guess,
so you get a warning naming the file instead of an edit. Pass the value at build
time:

```bash
docker build --build-arg VITE_CRUMBTRAIL_KEY=<your-ingest-key> .
```

Your key still has to reach whatever builds your frontend. If that build runs
somewhere other than the platform hosting your API, set the variable there too.

## If your frontend and backend are separate services

The injected browser init carries one field that decides whether the two halves
ever join:

```ts
networkCorrelationAllowedOrigins: ["http://127.0.0.1:19870"],
```

Crumbtrail joins a session to its backend requests by stamping
`X-Crumbtrail-Session-Id`, `X-Crumbtrail-Request-Id` and W3C `traceparent` on
outbound calls. Calls to the page's own origin are stamped automatically. Calls
to another origin, which is every call from a browser app to an API on a
different host or port, are stamped only when that origin is listed here:

```ts
networkCorrelationAllowedOrigins: [
  "https://api.example.com",
  "http://localhost:4000",
],
```

Leave it empty and both halves still capture, but they never join: the session
holds the failing click and the backend holds the failing request, with nothing
connecting the two.

The wizard fills the list from what your repository already states — a dev
server proxy target, an absolute API base URL in the app's env file, or the
local origin of a backend service it is wiring in the same run — and names those
origins in its summary. It never guesses beyond that, because stamping an origin
your app did not name would send trace context to a third party API and add a
CORS preflight to calls that had none. Anything the repository does not say, you
add here yourself.

Two things to check on the backend side: its CORS
`Access-Control-Allow-Headers` has to cover `x-crumbtrail-session-id`,
`x-crumbtrail-request-id` and `traceparent`, and the backend itself needs the
Crumbtrail SDK wired so it records the requests those headers arrive on. Run the
wizard once per service to do that.

When a request would have been stamped and its origin is not listed, the SDK
prints one line to the browser console naming that origin, so a missing entry
shows up while you are testing rather than as an empty dashboard later.

## Terminal output

The wizard negotiates colour and glyphs with your terminal once, at startup, and
renders down to whatever it finds. Truecolor terminals get the full brand
palette; 256-colour and 16-colour terminals get the nearest stand-ins; a
terminal that cannot do ANSI at all gets plain text. Piped or redirected output
is always plain, so `npx crumbtrail > setup.log` stays greppable.

Glyphs work the same way. Where UTF-8 is not safe — legacy Windows console under
code page 437, or a `C`/`POSIX` locale — the box drawing, dots and ticks become
ASCII, and typographic punctuation is folded down with them.

| Variable             | Effect                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NO_COLOR`           | Turn colour off entirely.                                                                                       |
| `FORCE_COLOR`        | `0` off, `1` sixteen colours, `2` 256, `3` truecolor. Wins over detection, including when the output is a pipe. |
| `CRUMBTRAIL_ASCII=1` | Force ASCII glyphs and punctuation, keeping colour.                                                             |

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
