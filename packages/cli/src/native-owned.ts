import type { Stack } from "crumbtrail-core";

const PACKAGES: Partial<
  Record<Stack, { package: string; docs: string; registration: string[] }>
> = {
  django: {
    package: "crumbtrail-python 0.1.0",
    docs: "python",
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
    registration: [
      "Create crumbtrail.Client(service=..., should_capture=...) after each worker forks.",
      "Register crumbtrail.flask.install(app, client) before serving requests.",
      "For SQLAlchemy call crumbtrail.database.instrument_sqlalchemy(engine) once, and uninstall on disposal.",
      "Call client.close(timeout=5) from worker shutdown and check its result.",
    ],
  },
  fastapi: {
    package: "crumbtrail-python 0.1.0",
    docs: "python",
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
    registration: [
      "Read the package README and register Crumbtrail::Middleware in the Rack middleware stack.",
      "Register the maintained ActiveRecord adapter once. Create the sender after each worker forks and close it during shutdown.",
    ],
  },
  go: {
    package: "github.com/CrumbtrailDev/crumbtrail-cli/packages/go",
    docs: "go",
    registration: [
      "Read the package README and wrap the net/http handler with crumbtrail.Middleware.",
      "Use crumbtrail.WrapDB for database/sql observation, with the actual driver name.",
      "Close the maintained sender during graceful server shutdown.",
    ],
  },
};

export function nativeCaptureSetup(
  stack: Stack,
  endpoint: string,
  service: string,
): string | null {
  const native = PACKAGES[stack];
  if (!native) return null;
  return [
    `Set up owned backend evidence with ${native.package}.`,
    "These native integrations require a released package or an explicitly configured, verified local package source.",
    "Package source and setup: https://github.com/CrumbtrailDev/crumbtrail-cli/tree/main/packages/" +
      native.docs,
    "Verify the package can restore before editing startup. If unavailable, report the missing package and stop this native setup.",
    "Do not copy or implement middleware, redaction, event construction, buffering or delivery in the application.",
    `Use service ${JSON.stringify(service)} and HTTPS capture endpoint ${JSON.stringify(endpoint)}.`,
    "Set CRUMBTRAIL_ENDPOINT and CRUMBTRAIL_INGEST_KEY in the runtime environment, never committed source.",
    "Select eligible routes from application code and exclude authentication routes. No eligible routes means no native capture.",
    "Native request capture requires the existing browser session and request correlation headers.",
    "Replace <your-app-name> with a stable name for this app before running it.",
    ...native.registration,
    "Database adapters report query metadata. SQL text, parameters and row values are withheld. Row diffs and transaction state are not provided.",
    "Keep existing OpenTelemetry exporters. OTLP traces and native JSON evidence have separate verification steps.",
    "Verify unchanged HTTP bytes and errors, redacted JSON states, request isolation, and backend.req.start/backend.req.end in the correlated session.",
    "For an instrumented query verify db.statement or db.error. Do not report body or database capture verified from a trace alone.",
  ].join("\n");
}
