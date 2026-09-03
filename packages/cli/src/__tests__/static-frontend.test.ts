// The static-frontend path: a page with no framework and no bundler, and the
// page an Express server hands to browsers out of `express.static`. Both used to
// be invisible — the first ended the wizard on "No supported framework" with
// exit code 1, the second was wired for its API and left dark in the browser.

import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { detect } from "../detect";
import { buildPlan } from "../inject/recipes";
import { findStaticMountDirs, insertIntoHtmlHead } from "../inject/text";
import { cleanup, fakeInjectIO, makeTmpRepo } from "./helpers";

const ENDPOINT = "https://ingest.example.com";
const KEY_PLACEHOLDER = "<your-ingest-key>";
const PAGE = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  "    <title>Landing</title>",
  "  </head>",
  "  <body><h1>Hi</h1></body>",
  "</html>",
  "",
].join("\n");

describe("detect — static frontends", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });

  it("classifies a plain index.html with no package.json as `static`", () => {
    const root = makeTmpRepo({ "index.html": PAGE, "app.js": "// hi\n" });
    roots.push(root);
    const result = detect(root);
    expect(result.recipe).toBe("static");
    expect(result.entryFile).toBe(path.join(root, "index.html"));
    expect(result.ambiguous).toBe(false);
  });

  it("finds the page under public/ too", () => {
    const root = makeTmpRepo({ "public/index.html": PAGE });
    roots.push(root);
    expect(detect(root).entryFile).toBe(
      path.join(root, "public", "index.html"),
    );
  });

  it("never pre-empts a framework: vite + index.html stays vite-spa", () => {
    const root = makeTmpRepo({
      "package.json": JSON.stringify({ devDependencies: { vite: "^5" } }),
      "index.html": PAGE,
    });
    roots.push(root);
    expect(detect(root).recipe).toBe("vite-spa");
  });

  it("matches a build-output page but refuses to name it as the entry", () => {
    const root = makeTmpRepo({ "dist/index.html": PAGE });
    roots.push(root);
    const result = detect(root);
    expect(result.recipe).toBe("static");
    expect(result.entryFile).toBeNull();
    expect(result.reasons.join(" ")).toContain("build output");
  });
});

describe("insertIntoHtmlHead", () => {
  it("puts the block inside head, above the closing tag", () => {
    const out = insertIntoHtmlHead(PAGE, "<script>x</script>")!;
    const head = out.indexOf("<head>");
    const script = out.indexOf("<script>x</script>");
    const closeHead = out.indexOf("</head>");
    expect(head).toBeLessThan(script);
    expect(script).toBeLessThan(closeHead);
  });

  it("puts the block before the first executable classic head script", () => {
    const out = insertIntoHtmlHead(
      PAGE.replace(
        "    <title>Landing</title>",
        '    <title>Landing</title>\n    <script src="/app.js"></script>',
      ),
      '<script src="/early-bootstrap.global.js"></script>',
    )!;
    const bootstrap = out.indexOf("early-bootstrap.global.js");
    const appScript = out.indexOf('<script src="/app.js"></script>');
    expect(bootstrap).toBeLessThan(appScript);
  });

  it("puts the block before an earlier module script and skips JSON data", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      '    <title>Landing</title>\n    <script type="application/ld+json">{"name":"site"}</script>\n    <script type="module" src="/app.js"></script>',
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script type="module" src="/app.js"></script>'),
    );
    expect(out.indexOf("<script>early</script>")).toBeGreaterThan(
      out.indexOf('<script type="application/ld+json">'),
    );
  });

  it("recognizes unquoted module types and JavaScript MIME parameters", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      [
        "    <title>Landing</title>",
        '    <script type=application/ld+json>{"name":"site"}</script>',
        '    <script type=module src="/app.js"></script>',
        '    <script type="text/javascript; charset=utf-8" src="/legacy.js"></script>',
      ].join("\n"),
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script type=module src="/app.js"></script>'),
    );
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf(
        '<script type="text/javascript; charset=utf-8" src="/legacy.js"></script>',
      ),
    );
  });

  it.each([
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
  ])("recognizes legacy JavaScript MIME type %s", (type) => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      `    <title>Landing</title>\n    <script type="${type}">app()</script>`,
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf(`<script type="${type}">`),
    );
  });

  it("skips commented script tags and script-like data text", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      [
        "    <title>Landing</title>",
        '    <!-- <script src="/commented.js"></script> -->',
        '    <script type="application/json">{"html":"<script src=\\"/data.js\\"></script>"}</script>',
        '    <script src="/app.js"></script>',
      ].join("\n"),
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    const bootstrap = out.indexOf("<script>early</script>");
    expect(bootstrap).toBeGreaterThan(out.indexOf("<!--"));
    expect(bootstrap).toBeGreaterThan(out.indexOf('</script>"}</script>') + 9);
    expect(bootstrap).toBeLessThan(
      out.indexOf('<script src="/app.js"></script>'),
    );
    expect(out).toContain('/commented.js"></script> -->');
  });

  it.each(["template", "noscript", "style", "textarea"])(
    "does not inject into an inert %s element",
    (tag) => {
      const html = PAGE.replace(
        "    <title>Landing</title>",
        [
          "    <title>Landing</title>",
          `    <${tag}><script src="/inert.js"></script></${tag}>`,
          '    <script src="/app.js"></script>',
        ].join("\n"),
      );
      const out = insertIntoHtmlHead(html, "<script>early</script>")!;
      expect(out.indexOf("<script>early</script>")).toBeGreaterThan(
        out.indexOf(`</${tag}>`),
      );
      expect(out.indexOf("<script>early</script>")).toBeLessThan(
        out.indexOf('<script src="/app.js"></script>'),
      );
    },
  );

  it("skips nested template contents", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      [
        "    <title>Landing</title>",
        '    <template><template><script src="/nested.js"></script></template></template>',
        '    <script src="/app.js"></script>',
      ].join("\n"),
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeGreaterThan(
      out.indexOf("</template></template>"),
    );
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script src="/app.js"></script>'),
    );
  });

  it("moves ahead of an executable script that appears before head", () => {
    const html =
      '<html><script src="/before-head.js"></script><head></head><body></body></html>';
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script src="/before-head.js"></script>'),
    );
  });

  it("treats an explicit empty type as executable", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      '    <title>Landing</title>\n    <script type="">data</script>\n    <script src="/app.js"></script>',
    );
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script type="">data</script>'),
    );
  });

  it("does not place the block after an executable script before body", () => {
    const html =
      '<html><script src="/before-body.js"></script><body>hi</body></html>';
    const out = insertIntoHtmlHead(html, "<script>early</script>")!;
    expect(out.indexOf("<script>early</script>")).toBeLessThan(
      out.indexOf('<script src="/before-body.js"></script>'),
    );
  });

  it("leaves existing Sentry and PostHog tags in place", () => {
    const html = PAGE.replace(
      "    <title>Landing</title>",
      [
        "    <title>Landing</title>",
        '    <script src="https://browser.sentry-cdn.com/8.0.0/bundle.min.js"></script>',
        '    <script src="https://cdn.posthog.com/posthog.js"></script>',
      ].join("\n"),
    );
    const out = insertIntoHtmlHead(
      html,
      '<script src="https://unpkg.com/crumbtrail-core@1.2.3/dist/early-bootstrap.global.js"></script>',
    )!;
    expect(out.indexOf("early-bootstrap.global.js")).toBeLessThan(
      out.indexOf("browser.sentry-cdn.com"),
    );
    expect(out).toContain("cdn.posthog.com");
  });

  it("splits a one-line head rather than landing outside it", () => {
    const out = insertIntoHtmlHead(
      "<html>\n  <head><title>x</title></head>\n  <body></body>\n</html>\n",
      "<script>x</script>",
    )!;
    expect(out.indexOf("<head>")).toBeLessThan(out.indexOf("<script>x"));
    expect(out.indexOf("<script>x")).toBeLessThan(out.indexOf("</head>"));
  });

  it("falls back to body, and gives up on a document with neither", () => {
    const body = insertIntoHtmlHead("<html><body>hi</body></html>", "<b/>")!;
    expect(body).toContain("<b/>");
    expect(insertIntoHtmlHead("just text", "<b/>")).toBeNull();
  });
});

describe("findStaticMountDirs", () => {
  it("reads the directory out of both common call shapes", () => {
    expect(
      findStaticMountDirs(
        'app.use(express.static(path.join(__dirname, "public")));',
      ),
    ).toEqual(["public"]);
    expect(findStaticMountDirs('app.use(express.static("assets"))')).toEqual([
      "assets",
    ]);
    expect(findStaticMountDirs('app.use(serveStatic("www"))')).toEqual(["www"]);
  });

  it("returns nothing rather than a guess for a computed directory", () => {
    expect(findStaticMountDirs("app.use(express.static(rootDir))")).toEqual([]);
  });
});

describe("buildPlan — static", () => {
  const CWD = "/site";
  const p = (...parts: string[]) => path.join(CWD, ...parts);

  it("rewrites the page with a script tag and a placeholder key", () => {
    const io = fakeInjectIO({ [p("index.html")]: PAGE });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "static",
        endpoint: ENDPOINT,
        entryFile: p("index.html"),
        serviceName: "web",
        sdkVersion: "1.2.3",
      },
      io,
    );
    expect(plan.kind).toBe("rewrite");
    expect(plan.targetPath).toBe(p("index.html"));
    expect(plan.content).toContain(
      '<script src="https://unpkg.com/crumbtrail-core@1.2.3/dist/early-bootstrap.global.js"></script>',
    );
    expect(plan.content).toContain('<script type="module">');
    expect(plan.content).toContain("https://esm.sh/crumbtrail-core@1.2.3");
    expect(plan.content).not.toContain("crumbtrail-core@1.2.3/early");
    expect(plan.content).toContain("parser-blocking");
    expect(plan.content).toContain(
      "approve this inline module with a nonce or hash",
    );
    expect(plan.content).toContain(
      'integrity and crossorigin="anonymous" can protect this external bootstrap tag only',
    );
    expect(plan.content).toContain("Offline:");
    expect(plan.content).toContain(
      "SRI does not protect the inline module or its esm.sh import",
    );
    expect(plan.content).not.toContain('integrity="');
    expect(plan.content).toContain(`httpAuthToken: "${KEY_PLACEHOLDER}"`);
    expect(plan.content?.split(KEY_PLACEHOLDER)).toHaveLength(2);
    expect(plan.content).toContain('service: "web"');
    // No env var: the wizard must not offer to write a key into a file the page
    // would never read.
    expect(plan.keyEnvVar).toBeUndefined();
    expect(plan.content).not.toMatch(/ctkey_/);
  });

  it("hands back guidance, never an error, when there is no page to edit", () => {
    const plan = buildPlan(
      { cwd: CWD, recipe: "static", endpoint: ENDPOINT, entryFile: null },
      fakeInjectIO({}),
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.snippet).not.toContain("early-bootstrap.global.js");
    expect(plan.snippet).toContain('<script type="module">');
    // The JS agent prompt would tell a bundler-less page to npm install and read
    // import.meta.env; the tag above is the whole instruction.
    expect(plan.agentPrompt).toBeUndefined();
    expect(plan.warnings.join(" ")).toMatch(/Paste the script tag/);
    expect(plan.snippet).toContain("https://esm.sh/crumbtrail-core@0.31.0");
  });

  it("keeps an older static SDK at the published SDK floor without a bootstrap", () => {
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "static",
        endpoint: ENDPOINT,
        entryFile: p("index.html"),
        sdkVersion: "0.48.0",
      },
      fakeInjectIO({ [p("index.html")]: PAGE }),
    );
    expect(plan.content).not.toContain("early-bootstrap.global.js");
    expect(plan.content).toContain("https://esm.sh/crumbtrail-core@0.48.0");
  });

  it("retrofits an existing static integration once a compatible SDK is supplied", () => {
    const wired = insertIntoHtmlHead(
      PAGE,
      [
        '<script type="module">',
        '  import { Crumbtrail } from "https://esm.sh/crumbtrail-core@0.49.0";',
        `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: "customer-key", remoteConfig: true, service: "web" });`,
        "</script>",
      ].join("\n"),
    )!;
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "static",
        endpoint: ENDPOINT,
        entryFile: p("index.html"),
        serviceName: "web",
        sdkVersion: "0.49.0",
      },
      fakeInjectIO({ [p("index.html")]: wired }),
    );
    expect(plan.kind).toBe("rewrite");
    expect(plan.content).toContain("early-bootstrap.global.js");
    expect(plan.content!.indexOf("early-bootstrap.global.js")).toBeLessThan(
      plan.content!.indexOf('<script type="module">'),
    );
  });

  it("returns an upgrade action instead of adding a mismatched bootstrap", () => {
    const wired = insertIntoHtmlHead(
      PAGE,
      '<script type="module">import { Crumbtrail } from "https://esm.sh/crumbtrail-core@0.48.0";</script>',
    )!;
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "static",
        endpoint: ENDPOINT,
        entryFile: p("index.html"),
        sdkVersion: "0.49.0",
      },
      fakeInjectIO({ [p("index.html")]: wired }),
    );
    expect(plan.kind).toBe("fallback-ai");
    expect(plan.content).toBeNull();
    expect(plan.warnings.join(" ")).toContain("pinned to 0.48.0");
    expect(plan.warnings.join(" ")).not.toContain("early-bootstrap.global.js");
    expect(plan.warnings.join(" ")).toMatch(/upgrade/i);
  });

  it("re-run: says the one remaining step instead of the snippet again", () => {
    const wired = insertIntoHtmlHead(
      PAGE,
      [
        '<script type="module">',
        '  import { Crumbtrail } from "https://esm.sh/crumbtrail-core@0.49.0";',
        `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: "customer-key", remoteConfig: true, service: "web" });`,
        "</script>",
      ].join("\n"),
    )!;
    const io = fakeInjectIO({ [p("index.html")]: wired });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "static",
        endpoint: ENDPOINT,
        entryFile: p("index.html"),
        serviceName: "web",
        sdkVersion: "0.49.0",
      },
      io,
    );
    expect(plan.kind).toBe("rewrite");
    expect(plan.content).toContain("early-bootstrap.global.js");
    expect(plan.warnings.join(" ")).not.toContain("Nothing to inject");
  });
});

describe("buildPlan — the frontend an Express app serves", () => {
  const CWD = "/api";
  const p = (...parts: string[]) => path.join(CWD, ...parts);
  const SERVER = [
    'import express from "express";',
    "const app = express();",
    'app.use(express.static("public"));',
    "app.listen(3000);",
    "",
  ].join("\n");

  it("wires the served page alongside the server", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({ dependencies: { express: "^4" } }),
      [p("server.js")]: SERVER,
      [p("public", "index.html")]: PAGE,
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "api",
        sdkVersion: "0.49.0",
      },
      io,
    );
    const extra = (plan.extraEdits ?? []).find(
      (edit) => edit.path === p("public", "index.html"),
    );
    expect(extra).toBeDefined();
    expect(extra!.content).toContain("early-bootstrap.global.js");
    expect(extra!.content).toContain('<script type="module">');
    // Same service as the server: it is one deployed app, and a `-web` label the
    // wizard never provisioned shows up nowhere.
    expect(extra!.content).toContain('service: "api"');
    expect(plan.warnings.join(" ")).toContain("public/index.html");
  });

  it("refuses build output and names the next action instead", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({ dependencies: { express: "^4" } }),
      [p("server.js")]: SERVER.replace('"public"', '"dist"'),
      [p("dist", "index.html")]: PAGE,
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "api",
      },
      io,
    );
    expect(
      (plan.extraEdits ?? []).some((edit) => edit.path.includes("dist")),
    ).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/built frontend from dist/);
    expect(plan.warnings.join(" ")).toMatch(/npx crumbtrail/);
  });

  it("does not wire the same page twice", () => {
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({ dependencies: { express: "^4" } }),
      [p("server.js")]: SERVER,
      [p("public", "index.html")]: PAGE.replace(
        "</head>",
        '<script type="module">import "crumbtrail-core";</script></head>',
      ),
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "api",
      },
      io,
    );
    expect(
      (plan.extraEdits ?? []).some((edit) => edit.path.includes("index.html")),
    ).toBe(false);
  });

  it("retrofits early capture into an existing served page", () => {
    const server = [
      'import express from "express";',
      'import { Crumbtrail } from "crumbtrail-core";',
      'import { createCrumbtrailExpressMiddleware, createCrumbtrailExpressErrorMiddleware } from "crumbtrail-node";',
      "const app = express();",
      'app.use(createCrumbtrailExpressMiddleware({ endpoint: "https://ingest.example.com", authToken: process.env.CRUMBTRAIL_KEY }));',
      'app.use(express.static("public"));',
      "app.use(createCrumbtrailExpressErrorMiddleware());",
      "app.listen(3000);",
      "",
    ].join("\n");
    const page = insertIntoHtmlHead(
      PAGE,
      [
        '<script type="module">',
        '  import { Crumbtrail } from "https://esm.sh/crumbtrail-core@0.49.0";',
        `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: "${KEY_PLACEHOLDER}", remoteConfig: true, service: "api" });`,
        "</script>",
      ].join("\n"),
    )!;
    const io = fakeInjectIO({
      [p("package.json")]: JSON.stringify({ dependencies: { express: "^4" } }),
      [p("server.js")]: server,
      [p("public", "index.html")]: page,
    });
    const plan = buildPlan(
      {
        cwd: CWD,
        recipe: "express",
        endpoint: ENDPOINT,
        entryFile: p("server.js"),
        serviceName: "api",
        sdkVersion: "0.49.0",
      },
      io,
    );
    const extra = (plan.extraEdits ?? []).find(
      (edit) => edit.path === p("public", "index.html"),
    );
    expect(extra).toBeDefined();
    expect(extra!.content.indexOf("early-bootstrap.global.js")).toBeLessThan(
      extra!.content.indexOf('<script type="module">'),
    );
    expect(plan.warnings.join(" ")).toContain("early browser bootstrap");
  });
});
