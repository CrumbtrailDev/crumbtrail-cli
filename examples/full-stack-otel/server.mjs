import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTraceparent } from "../../packages/core/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CRUMBTRAIL_ENDPOINT = "http://localhost:9898";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

/**
 * A backend that is instrumented with OpenTelemetry only — it has NO Crumbtrail SDK and
 * sets NO `X-Crumbtrail-Request-Id`. It continues the W3C trace the browser SDK propagated
 * via `traceparent`, and exports the resulting span over OTLP to Crumbtrail's `/v1/traces`
 * ingest. This mirrors "Path C": a team already on a telemetry stack pointing their
 * exporter at :9898. The OTLP `traceId → requestId` bridge then links the front-end click
 * to this back-end error with zero hand-wiring.
 *
 * The OTLP payload is hand-built (no `@opentelemetry/*` dependency) so the example stays
 * lean and runnable with just `node`; it is byte-for-byte what a real exporter would POST.
 */
export function createOtelDemoApp(options = {}) {
  const app = express();
  const crumbtrailEndpoint = normalizeEndpoint(
    options.crumbtrailEndpoint ??
      options.endpoint ??
      process.env.CRUMBTRAIL_ENDPOINT ??
      DEFAULT_CRUMBTRAIL_ENDPOINT,
  );
  const configuredSessionId = () =>
    boundedOptionalString(
      typeof options.sessionId === "function"
        ? options.sessionId()
        : (options.sessionId ?? process.env.CRUMBTRAIL_SESSION_ID),
    );
  const authToken = boundedOptionalString(
    options.authToken ?? process.env.CRUMBTRAIL_AUTH_TOKEN,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const serviceName =
    boundedOptionalString(options.serviceName) ?? "otel-demo-api";
  const staticDir = options.staticDir ?? __dirname;

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, example: "full-stack-otel" });
  });

  app.get("/demo-config.js", (_req, res) => {
    res
      .type("application/javascript")
      .send(
        `window.__CRUMBTRAIL_DEMO__ = ${JSON.stringify({ crumbtrailEndpoint })};\n`,
      );
  });

  app.get("/api/demo-bug", async (req, res) => {
    // Adopt the trace the browser propagated. If absent (e.g. curled directly), start one.
    const incoming = parseTraceparent(req.get("traceparent"));
    const traceId = incoming?.traceId ?? randomHex(16);
    const clientSpanId = incoming?.spanId;
    const route = "/api/demo-bug";

    // The backend logs a precise, diagnostic failure (per VISION: "better logging").
    const statusMessage =
      "Intentional Crumbtrail OTLP demo failure: upstream inventory check returned 500";

    await emitOtlpErrorSpan({
      endpoint: crumbtrailEndpoint,
      authToken,
      fetchImpl,
      traceId,
      parentSpanId: clientSpanId,
      sessionId: configuredSessionId(),
      serviceName,
      route,
      method: req.method,
      statusMessage,
    });

    res.status(500).json({
      ok: false,
      error: "DEMO_BUG",
      message:
        "The demo route failed safely. The backend exported an OTLP error span to Crumbtrail.",
      // The trace id doubles as the correlation key the browser SDK already emitted.
      requestId: traceId,
      traceId,
    });
  });

  app.use(
    express.static(staticDir, { extensions: ["html"], index: "index.html" }),
  );

  return app;
}

async function emitOtlpErrorSpan({
  endpoint,
  authToken,
  fetchImpl,
  traceId,
  parentSpanId,
  sessionId,
  serviceName,
  route,
  method,
  statusMessage,
}) {
  const startMs = Date.now();
  const resourceAttributes = [
    { key: "service.name", value: { stringValue: serviceName } },
  ];
  // The session id rides along as an OTLP resource attribute so Crumbtrail can route the
  // span into the right session and join it at session level too.
  if (sessionId)
    resourceAttributes.push({
      key: "crumbtrail.session.id",
      value: { stringValue: sessionId },
    });

  const span = {
    traceId,
    spanId: randomHex(8),
    name: `${method} ${route}`,
    kind: 2, // SERVER
    startTimeUnixNano: msToUnixNano(startMs),
    endTimeUnixNano: msToUnixNano(startMs + 12),
    status: { code: 2, message: statusMessage }, // STATUS_CODE_ERROR
    attributes: [
      { key: "http.request.method", value: { stringValue: method } },
      { key: "http.route", value: { stringValue: route } },
      { key: "http.response.status_code", value: { intValue: 500 } },
    ],
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;

  const payload = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ spans: [span] }],
      },
    ],
  };

  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["X-Crumbtrail-Auth"] = authToken;

  const response = await fetchImpl(`${endpoint}/v1/traces`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`OTLP ingest returned HTTP ${response.status}`);
  }
}

export function startOtelDemoServer(options = {}) {
  const app = createOtelDemoApp(options);
  const port = normalizePort(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      resolve({ app, server, address, url: addressToUrl(address, host) });
    });
    server.once("error", reject);
  });
}

function msToUnixNano(ms) {
  return `${ms}000000`;
}

function randomHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes; i += 1) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function normalizeEndpoint(value) {
  const endpoint =
    String(value || DEFAULT_CRUMBTRAIL_ENDPOINT).trim() ||
    DEFAULT_CRUMBTRAIL_ENDPOINT;
  return endpoint.replace(/\/+$/, "");
}

function boundedOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 256);
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535
    ? port
    : DEFAULT_PORT;
}

function addressToUrl(address, fallbackHost) {
  if (!address || typeof address === "string") return undefined;
  const host =
    address.address === "::" ? "localhost" : address.address || fallbackHost;
  return `http://${host}:${address.port}`;
}

function readCliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--port" && next !== undefined) {
      options.port = next;
      index += 1;
    } else if (arg === "--host" && next !== undefined) {
      options.host = next;
      index += 1;
    } else if (
      (arg === "--endpoint" || arg === "--crumbtrail-endpoint") &&
      next !== undefined
    ) {
      options.crumbtrailEndpoint = next;
      index += 1;
    } else if (arg === "--session-id" && next !== undefined) {
      options.sessionId = next;
      index += 1;
    }
  }
  return options;
}

if (process.argv[1] === __filename) {
  startOtelDemoServer(readCliOptions(process.argv.slice(2)))
    .then(({ url }) => {
      console.log(`Crumbtrail OTLP demo listening at ${url}`);
      console.log(
        "GET /api/demo-bug to export a correlated OTLP error span to Crumbtrail.",
      );
    })
    .catch((error) => {
      console.error(
        "Failed to start Crumbtrail OTLP demo:",
        error?.message || error,
      );
      process.exitCode = 1;
    });
}
