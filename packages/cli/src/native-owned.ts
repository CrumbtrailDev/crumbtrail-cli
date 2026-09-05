import type { Stack } from "crumbtrail-core";

/**
 * A maintained native backend package the CLI may point a setup agent at.
 *
 * `published` is the gate, and it is the whole reason this module is not a plain
 * lookup table. The setup wizard's standing invariant, stated in the root
 * README's "Other registries" section, is that it will not wire an app against a
 * package it cannot resolve. `crumbtrail-python` is on PyPI and the `crumbtrail`
 * gem is on RubyGems, and the Go module is tagged `packages/go/v0.1.0`, so every
 * stack in this table now carries native guidance. Nothing is gated today, which
 * makes the OTLP prompt in `install/index.ts` unreached; it is kept and tested
 * directly as the answer for the next stack added before its package ships.
 *
 * Flip an entry to `true` in the same change that publishes its artifact, and
 * check the registration lines against the package source at the same time.
 */
export interface NativePackage {
  /** How the guide names the artifact, including the version to install. */
  package: string;
  /** Directory under `packages/` holding the source and its README. */
  docs: string;
  /** Whether the artifact resolves from its public registry today. */
  published: boolean;
  /** Registration steps, each naming an API that exists in the package source. */
  registration: string[];
}

export const NATIVE_PACKAGES: Partial<Record<Stack, NativePackage>> = {
  django: {
    package: "crumbtrail-python 0.1.0",
    docs: "python",
    published: true,
    registration: [
      "Create crumbtrail.Client(service=..., should_capture=...) after each worker forks.",
      "In wsgi.py use crumbtrail.django.wrap_wsgi(get_wsgi_application(), client).",
      "For ASGI use crumbtrail.ASGIMiddleware for HTTP only. Django ASGI database capture is unsupported.",
      "Call client.close(timeout=5) from worker shutdown and check its result.",
    ],
  },
  flask: {
    package: "crumbtrail-python 0.1.0",
    docs: "python",
    published: true,
    registration: [
      "Create crumbtrail.Client(service=..., should_capture=...) after each worker forks.",
      "Register crumbtrail.flask.install(app, client) before serving requests.",
      "For SQLAlchemy call crumbtrail.database.instrument_sqlalchemy(engine) once and keep the returned uninstall for engine disposal.",
      "Call client.close(timeout=5) from worker shutdown and check its result.",
    ],
  },
  fastapi: {
    package: "crumbtrail-python 0.1.0",
    docs: "python",
    published: true,
    registration: [
      "Create crumbtrail.Client(service=..., should_capture=...) after each worker forks.",
      "Register app.add_middleware(crumbtrail.ASGIMiddleware, client=client).",
      "For SQLAlchemy call crumbtrail.database.instrument_sqlalchemy(engine) once, or pass async_engine.sync_engine.",
      "Call client.close(timeout=5) from worker shutdown and check its result.",
    ],
  },
  rails: {
    package: "crumbtrail gem 0.1.0",
    docs: "ruby",
    published: true,
    registration: [
      "Read the package README and insert Crumbtrail::Middleware into the Rack middleware stack with its sink, service and route arguments.",
      "Call Crumbtrail::ActiveRecord.install(engine:) once with the database engine name.",
      "Create Crumbtrail::Sender after each worker forks and call close on it during shutdown.",
    ],
  },
  go: {
    package: "github.com/CrumbtrailDev/crumbtrail-cli/packages/go v0.1.0",
    docs: "go",
    published: true,
    registration: [
      "Read the package README and wrap the net/http handler with crumbtrail.Middleware(options).",
      "Use crumbtrail.WrapDB(db, engine) for database/sql observation, with the actual driver name, and call the returned type's context methods.",
      "Close the maintained sender during graceful server shutdown.",
    ],
  },
};

export interface NativeCaptureOptions {
  /**
   * Environment variable the surrounding plan uses for the ingest key.
   *
   * The caller decides this because the same plan can write more than one file:
   * the Python OTLP recipe writes a launch helper that reads `CRUMBTRAIL_KEY`,
   * and a native guide beside it naming a different variable would leave the
   * reader with two documents and no way to tell which one is wrong.
   */
  keyEnv?: string;
  /**
   * Whether `service` is a real resolved name rather than the `<your-app-name>`
   * stand-in. Only the stand-in needs the line telling the reader to replace it.
   */
  hasExplicitServiceName?: boolean;
}

const DEFAULT_KEY_ENV = "CRUMBTRAIL_KEY";

/**
 * Registration guidance for a stack whose native package is published.
 *
 * Returns `null` for every stack today, which is what keeps the OTLP path alive
 * in every caller. See `NativePackage.published`.
 */
export function nativeCaptureSetup(
  stack: Stack,
  endpoint: string,
  service: string,
  options: NativeCaptureOptions = {},
): string | null {
  const native = NATIVE_PACKAGES[stack];
  if (!native || !native.published) return null;
  return renderNativeCaptureSetup(native, endpoint, service, options);
}

/**
 * The guidance body itself, separated from the gate so tests can check what the
 * text says without a switch that would also turn it on in the product.
 */
export function renderNativeCaptureSetup(
  native: NativePackage,
  endpoint: string,
  service: string,
  options: NativeCaptureOptions = {},
): string {
  const keyEnv = options.keyEnv?.trim() || DEFAULT_KEY_ENV;
  return [
    `Set up owned backend evidence with ${native.package}.`,
    "These native integrations require a released package or an explicitly configured, verified local package source.",
    "Package source and setup: https://github.com/CrumbtrailDev/crumbtrail-cli/tree/main/packages/" +
      native.docs,
    "Verify the package can restore before editing startup. If unavailable, report the missing package and stop this native setup.",
    "Do not copy or implement middleware, redaction, event construction, buffering or delivery in the application.",
    `Use service ${JSON.stringify(service)} and capture endpoint ${JSON.stringify(endpoint)}.`,
    `Set CRUMBTRAIL_ENDPOINT and ${keyEnv} in the runtime environment, never committed source.`,
    "Select eligible routes from application code and exclude authentication routes. No eligible routes means no native capture.",
    "Native request capture requires the existing browser session and request correlation headers.",
    ...(options.hasExplicitServiceName
      ? []
      : [
          "Replace <your-app-name> with a stable name for this app before running it.",
        ]),
    ...native.registration,
    "Database adapters report query metadata. SQL text, parameters and row values are withheld. Row diffs and transaction state are not provided.",
    "Keep existing OpenTelemetry exporters. OTLP traces and native JSON evidence have separate verification steps.",
    "Verify unchanged HTTP bytes and errors, redacted JSON states, request isolation, and backend.req.start/backend.req.end in the correlated session.",
    "For an instrumented query verify db.statement or db.error. Do not report body or database capture verified from a trace alone.",
  ].join("\n");
}
