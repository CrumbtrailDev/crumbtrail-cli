/**
 * Browser regression for the static HTML bootstrap.
 *
 * The page deliberately puts a failing classic script, a failing deferred
 * module script, and requests from both script kinds before the module that
 * initializes the full SDK. It serves the locally built dist files, so this
 * checks the shipped IIFE and the real browser module boundary without using a
 * published package or a CDN.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const distRoot = resolve("packages/core/dist");
const bootstrapSource = await readFile(
  resolve(distRoot, "early-bootstrap.global.js"),
  "utf8",
);
if (
  !/^"use strict";\s*var CrumbtrailEarlyBootstrap = \(\(\) =>/.test(
    bootstrapSource,
  )
)
  throw new Error("early bootstrap is not a classic IIFE artifact");
if (/\b(?:import|export)\s/.test(bootstrapSource))
  throw new Error("early bootstrap still contains module syntax");

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<title>Crumbtrail early bootstrap regression</title>
<script src="/core/early-bootstrap.global.js"></script>
<script>
  window.__earlyOrder = [];
  window.__bootstrapQueueBeforeSecond = window.__crumbtrailEarly;
  window.__earlyOrder.push("classic-after-first-bootstrap");
</script>
<script src="/core/early-bootstrap.global.js"></script>
<script>
  window.__bootstrapWasIdempotent = window.__crumbtrailEarly === window.__bootstrapQueueBeforeSecond;
  window.__bootstrapWasPresentInClassic = Boolean(window.__crumbtrailEarly);
  window.__earlyOrder.push("classic-after-second-bootstrap");
  fetch("/api/classic-before-init");
</script>
<script src="/missing-classic.js"></script>
<script type="module" src="/missing-module.js"></script>
<script type="module">
  import "/core/early.js";
  window.__earlyOrder.push("module-before-init");
  fetch("/api/module-before-init");
</script>
<script type="module">
  import { Crumbtrail } from "/core/index.js";

  window.__earlyOrder.push("module-init");
  const batches = [];
  const transport = {
    sendEvents(events) {
      batches.push(...events);
      return Promise.resolve();
    },
    sendBlob() {
      return Promise.resolve();
    },
    startSession() {
      return Promise.resolve();
    },
    endSession() {
      return Promise.resolve();
    },
    sendBugReport() {
      return Promise.resolve();
    },
  };

  const logger = Crumbtrail.init({
    transportInstance: transport,
    sessionPersistence: "memory",
    remoteConfig: false,
    console: false,
    interactions: false,
    keystrokes: false,
    scroll: false,
    visibility: false,
    clipboard: false,
    cookies: false,
    storage: false,
    performance: false,
    heartbeat: false,
    uiNumbers: false,
    listeners: false,
    eventSource: false,
    webSocket: false,
    workers: false,
    widget: false,
    environment: false,
    domSnapshot: false,
    errors: true,
    network: true,
    flushIntervalMs: 100_000,
    flushBufferSize: 1_000,
  });
  await fetch("/api/after-init");

  window.__earlyBootstrapResult = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await logger.stop();
    return {
      order: window.__earlyOrder,
      bootstrapWasPresentInClassic: window.__bootstrapWasPresentInClassic,
      bootstrapWasIdempotent: window.__bootstrapWasIdempotent,
      events: batches.map((event) => ({
        kind: event.k,
        early: event.d?.early === true,
        transport: event.d?.transport,
        url: event.d?.url,
      })),
    };
  })();
</script>`;

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
      return;
    }

    if (request.url?.startsWith("/core/")) {
      const relativePath = request.url.slice("/core/".length);
      if (!relativePath || relativePath.includes("..")) {
        response.writeHead(400);
        response.end("bad path");
        return;
      }
      const filePath = resolve(distRoot, relativePath);
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(body);
      return;
    }

    if (request.url?.startsWith("/api/")) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end('{"ok":true}');
      return;
    }

    response.writeHead(404);
    response.end("not found");
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolveServer) =>
  server.listen(0, "127.0.0.1", resolveServer),
);
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("early bootstrap browser test server did not expose a port");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "load",
  });
  await page.waitForFunction(
    () => Boolean(window.__earlyBootstrapResult),
    undefined,
    { timeout: 10_000 },
  );
  const result = await page.evaluate(() => window.__earlyBootstrapResult);

  if (!result.bootstrapWasPresentInClassic)
    throw new Error(
      "classic script ran before the bootstrap installed its queue",
    );
  if (!result.bootstrapWasIdempotent)
    throw new Error("loading the bootstrap twice replaced the existing queue");
  if (
    result.order.join(",") !==
    "classic-after-first-bootstrap,classic-after-second-bootstrap,module-before-init,module-init"
  )
    throw new Error(`unexpected script order: ${result.order.join(",")}`);

  const earlyRequests = result.events.filter(
    (event) => event.kind === "net.req" && event.early,
  );
  for (const path of ["/api/classic-before-init", "/api/module-before-init"]) {
    if (!earlyRequests.some((event) => event.url.endsWith(path)))
      throw new Error(
        `pre-init request was not replayed as early evidence: ${path}`,
      );
  }

  const afterInitRequests = result.events.filter(
    (event) =>
      event.kind === "net.req" && event.url.endsWith("/api/after-init"),
  );
  if (afterInitRequests.length !== 1 || afterInitRequests[0].early)
    throw new Error(
      "the full SDK did not coexist with the bootstrap exactly once",
    );

  const resourceFailures = result.events.filter(
    (event) => event.kind === "net.err" && event.transport === "resource",
  );
  for (const path of ["/missing-classic.js", "/missing-module.js"]) {
    if (!resourceFailures.some((event) => event.url.endsWith(path)))
      throw new Error(`pre-init resource failure was not captured: ${path}`);
  }

  if (pageErrors.length > 0)
    throw new Error(
      `unexpected browser page errors: ${pageErrors.join(" | ")}`,
    );

  console.log(
    `PASS browser early bootstrap: order=${result.order.join(">")} earlyRequests=${earlyRequests.length} resourceFailures=${resourceFailures.length}`,
  );
} finally {
  await browser.close();
  await new Promise((resolveServer, reject) =>
    server.close((error) => (error ? reject(error) : resolveServer())),
  );
}
