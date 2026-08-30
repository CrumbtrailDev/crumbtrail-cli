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
    expect(plan.content).toContain('<script type="module">');
    expect(plan.content).toContain("https://esm.sh/crumbtrail-core@1.2.3");
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
    expect(plan.snippet).toContain('<script type="module">');
    // The JS agent prompt would tell a bundler-less page to npm install and read
    // import.meta.env; the tag above is the whole instruction.
    expect(plan.agentPrompt).toBeUndefined();
    expect(plan.warnings.join(" ")).toMatch(/Paste the script tag/);
  });

  it("re-run: says the one remaining step instead of the snippet again", () => {
    const wired = insertIntoHtmlHead(
      PAGE,
      [
        '<script type="module">',
        '  import { Crumbtrail } from "https://esm.sh/crumbtrail-core@1.2.3";',
        `  Crumbtrail.init({ httpEndpoint: "${ENDPOINT}", httpAuthToken: "${KEY_PLACEHOLDER}", remoteConfig: true, service: "web" });`,
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
      },
      io,
    );
    expect(plan.kind).toBe("skip-already-wired");
    expect(plan.warnings.join(" ")).toContain(KEY_PLACEHOLDER);
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
      },
      io,
    );
    const extra = (plan.extraEdits ?? []).find(
      (edit) => edit.path === p("public", "index.html"),
    );
    expect(extra).toBeDefined();
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
});
