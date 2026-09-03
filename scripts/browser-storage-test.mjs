/**
 * Executable browser regression for storage rejection observation.
 *
 * It serves the built SDK from a loopback HTTP origin because file: pages have
 * an opaque origin and do not prove browser-level unhandledrejection behavior.
 * Run with `pnpm test:browser-storage` after installing the repository's
 * Playwright Chromium browser.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const distRoot = resolve("packages/core/dist");
const pageHtml = `<!doctype html>
<meta charset="utf-8">
<title>Crumbtrail browser storage regression</title>
<script type="module">
  import { Crumbtrail } from "/core/index.js";

  window.runStorageRegression = async () => {
    const unhandledRejections = [];
    const eventBatches = [];
    const onUnhandledRejection = (event) => {
      unhandledRejections.push(String(event.reason?.name ?? event.reason));
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    const transport = {
      sendEvents(events) {
        eventBatches.push(events);
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
      console: false,
      network: false,
      interactions: false,
      keystrokes: false,
      scroll: false,
      visibility: false,
      clipboard: false,
      errors: false,
      performance: false,
      cookies: false,
      storage: true,
      environment: false,
      domSnapshot: false,
      heartbeat: false,
      uiNumbers: false,
      listeners: false,
      eventSource: false,
      webSocket: false,
      workers: false,
      widget: false,
      captureIdb: true,
      captureCacheApi: true,
      autoFlagOnStorageFailure: true,
      autoFlagOnError: false,
      autoFlagOnUnhandledRejection: false,
      remoteConfig: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const databaseName = "crumbtrail-browser-storage-" + Date.now();
    let sawVersionChange = false;
    const openDatabase = (version, onUpgrade) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, version);
        request.addEventListener("upgradeneeded", () => {
          try {
            onUpgrade(request.result);
          } catch (error) {
            reject(error);
          }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
    const firstDatabase = await openDatabase(1, (database) => {
      const store = database.createObjectStore("store", { keyPath: "id" });
      try {
        database.createObjectStore("store");
      } catch {
        // Intentional synchronous upgrade failure.
      }
      store.createIndex("index", "id");
      try {
        store.createIndex("index", "id");
      } catch {
        // Intentional synchronous upgrade failure.
      }
      try {
        store.deleteIndex("missing");
      } catch {
        // Intentional synchronous upgrade failure.
      }
      try {
        indexedDB.cmp({}, {});
      } catch {
        // Intentional synchronous IndexedDB factory failure.
      }
    });
    firstDatabase.addEventListener("versionchange", () => {
      sawVersionChange = true;
      firstDatabase.close();
    });
    const secondDatabase = await openDatabase(2, (database) => {
      try {
        database.createObjectStore("store");
      } catch {
        // Intentional synchronous failure during a later upgrade.
      }
    });
    secondDatabase.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.addEventListener("success", resolve);
      request.addEventListener("error", () => reject(request.error));
    });
    const cache = await caches.open("crumbtrail-browser-storage-regression");
    // Cache.add rejects for this served 404. The unhandled rejection is
    // intentional. The SDK must observe it while preserving that browser
    // lifecycle event for the page.
    void cache.add("/crumbtrail-storage-regression-404");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await logger.stop();

    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    return {
      origin: location.origin,
      sawVersionChange,
      unhandledRejectionCount: unhandledRejections.length,
      storageOperations: eventBatches
        .flat()
        .filter((event) => event.k === "stor")
        .map((event) => event.d.op),
    };
  };
</script>`;

function contentType(path) {
  switch (extname(path)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
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
  throw new Error("browser storage test server did not expose a port");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, {
    waitUntil: "load",
  });
  const result = await page.evaluate(() => window.runStorageRegression());

  if (
    result.origin === "null" ||
    !result.origin.startsWith("http://127.0.0.1:")
  )
    throw new Error(
      `expected a non-opaque loopback origin, got ${result.origin}`,
    );
  if (!result.sawVersionChange)
    throw new Error(
      "browser did not deliver the IndexedDB versionchange event",
    );
  if (result.unhandledRejectionCount < 1)
    throw new Error(
      "browser did not deliver the intentional unhandled rejection",
    );
  if (!result.storageOperations.includes("add"))
    throw new Error("browser did not capture the rejected Cache.add operation");
  for (const operation of [
    "database.createObjectStore",
    "objectStore.createIndex",
    "objectStore.deleteIndex",
    "cmp",
  ]) {
    if (!result.storageOperations.includes(operation))
      throw new Error(`browser did not capture IndexedDB ${operation}`);
  }

  console.log(
    `PASS browser storage: origin=${result.origin} unhandledrejections=${result.unhandledRejectionCount} operations=${result.storageOperations.join(",")}`,
  );
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
