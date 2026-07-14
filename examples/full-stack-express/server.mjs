import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
} from "../../packages/node/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CRUMBTRAIL_ENDPOINT = "http://localhost:9898";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const REQUEST_HEADER = "x-crumbtrail-request-id";

export function createDemoApp(options = {}) {
  const app = express();
  const crumbtrailEndpoint = normalizeEndpoint(
    options.crumbtrailEndpoint ??
      options.endpoint ??
      process.env.CRUMBTRAIL_ENDPOINT ??
      DEFAULT_CRUMBTRAIL_ENDPOINT,
  );
  const configuredSessionId = boundedOptionalString(
    options.sessionId ?? process.env.CRUMBTRAIL_SESSION_ID,
  );
  const configuredAuthToken = boundedOptionalString(
    options.authToken ?? process.env.CRUMBTRAIL_AUTH_TOKEN,
  );
  const staticDir = options.staticDir ?? __dirname;
  const middlewareOptions = {
    endpoint: crumbtrailEndpoint,
    authToken: configuredAuthToken,
    sessionId: configuredSessionId,
    fetch: options.fetch,
    signal: options.signal,
    sessionStartedAt: options.sessionStartedAt,
    onWarning: options.onWarning,
  };

  app.disable("x-powered-by");

  app.use(createCrumbtrailExpressMiddleware(middlewareOptions));

  app.get("/demo-config.js", (_req, res) => {
    res
      .type("application/javascript")
      .send(
        `window.__CRUMBTRAIL_DEMO__ = ${JSON.stringify({ crumbtrailEndpoint })};\n`,
      );
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, example: "full-stack-express" });
  });

  app.get("/api/demo-bug", async (_req, _res, next) => {
    await Promise.resolve();
    next(new Error("Intentional Crumbtrail Express demo failure"));
  });

  app.use(
    "/packages/core/dist",
    express.static(join(__dirname, "../../packages/core/dist")),
  );
  app.use(
    express.static(staticDir, { extensions: ["html"], index: "index.html" }),
  );

  app.use(createCrumbtrailExpressErrorMiddleware(middlewareOptions));

  app.use((error, req, res, _next) => {
    const requestId = boundedOptionalString(req.get(REQUEST_HEADER));
    if (requestId) res.setHeader("X-Crumbtrail-Request-Id", requestId);

    res.status(500).json({
      ok: false,
      error: "DEMO_BUG",
      message:
        "The demo route failed safely. Inspect Crumbtrail artifacts for correlated details.",
      requestId,
    });
  });

  return app;
}

export function startDemoServer(options = {}) {
  const app = createDemoApp(options);
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
  startDemoServer(readCliOptions(process.argv.slice(2)))
    .then(({ url }) => {
      console.log(`Crumbtrail Express demo listening at ${url}`);
      console.log(
        "Open the URL and click “Trigger failing request” to capture correlated client/backend evidence.",
      );
    })
    .catch((error) => {
      console.error(
        "Failed to start Crumbtrail Express demo:",
        error?.message || error,
      );
      process.exitCode = 1;
    });
}
