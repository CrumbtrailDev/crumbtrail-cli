import { describe, expect, it } from "vitest";
import {
  analyzeSource,
  prependIntoSource,
  prologueEnd,
  referencesCrumbtrail,
  widenCustomCorsAllowedHeaders,
  wireFlutterMain,
} from "../inject/text";

describe("custom CORS policy widening", () => {
  it("widens the unique final Set allowlist without changing its inputs", () => {
    const source = [
      'const SAFELISTED_HEADERS = ["Accept"]',
      'const CONFIGURED_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set([...SAFELISTED_HEADERS, ...CONFIGURED_HEADERS])].sort()",
      "export function corsMiddleware(): MiddlewareHandler {",
      "  return {",
      '    "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", "),',
      "  }",
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(true);
    expect(result.needsManual).toBe(false);
    expect(result.text).toContain(
      '[...new Set([...SAFELISTED_HEADERS, ...CONFIGURED_HEADERS, "x-crumbtrail-session-id", "x-crumbtrail-request-id", "traceparent"])].sort()',
    );
    expect(result.text).toContain(
      'const CONFIGURED_HEADERS = ["Authorization"]',
    );
  });

  it("refuses a final allowlist with multiple Set inputs", () => {
    const source = [
      'const FIRST_HEADERS = ["Authorization"]',
      'const SECOND_HEADERS = ["Content-Type"]',
      "const ALLOW_HEADERS = [...new Set(FIRST_HEADERS), ...new Set(SECOND_HEADERS)]",
      "export function corsMiddleware() {",
      '  return { "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ") }',
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("refuses a Set used by only one branch of the emitted policy", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = strict ? [...new Set(BASE_HEADERS)].sort() : BASE_HEADERS",
      "export function corsMiddleware() {",
      '  return { "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ") }',
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("refuses a final Set whose values are filtered before serialization", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set(BASE_HEADERS)].sort()",
      "export function corsMiddleware() {",
      '  return { "Access-Control-Allow-Headers": ALLOW_HEADERS.filter(isPermitted).join(", ") }',
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("ignores header examples inside an unexecuted nested function", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set(BASE_HEADERS)].sort()",
      "export function corsMiddleware() {",
      "  function unusedExample() {",
      '    return { "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ") }',
      "  }",
      "  return next",
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("ignores a header object that is not part of a return value", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set(BASE_HEADERS)].sort()",
      "export function corsMiddleware() {",
      "  const unusedExample = {",
      '    "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ")',
      "  }",
      "  return next",
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });

  it("resolves returned header objects in their lexical block", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set([...BASE_HEADERS])].sort()",
      "export function corsMiddleware(active) {",
      '  const headers = { "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ") }',
      "  if (!active) {",
      "    const headers = { ignored: true }",
      "    consume(headers)",
      "  }",
      "  return headers",
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(true);
    expect(result.needsManual).toBe(false);
  });

  it("does not resolve a header object declared after its return", () => {
    const source = [
      'const BASE_HEADERS = ["Authorization"]',
      "const ALLOW_HEADERS = [...new Set([...BASE_HEADERS])].sort()",
      "export function corsMiddleware() {",
      "  return headers",
      '  const headers = { "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", ") }',
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
  });

  it("refuses an installed function with multiple literal header policies", () => {
    const source = [
      'const FIRST_HEADERS = ["Authorization"]',
      'const SECOND_HEADERS = ["Content-Type"]',
      "export function corsMiddleware() {",
      '  first["Access-Control-Allow-Headers"] = FIRST_HEADERS.join(", ")',
      '  second["Access-Control-Allow-Headers"] = SECOND_HEADERS.join(", ")',
      "}",
    ].join("\n");
    const result = widenCustomCorsAllowedHeaders(source, "corsMiddleware");
    expect(result.changed).toBe(false);
    expect(result.needsManual).toBe(true);
    expect(result.text).toBe(source);
  });
});

const BLOCK =
  'import { Crumbtrail } from "crumbtrail-core";\nCrumbtrail.init({});';

describe("prologueEnd", () => {
  it("keeps a shebang and directive prologue together", () => {
    const lines = ["#!/usr/bin/env node", '"use strict";', "const x = 1;"];
    expect(prologueEnd(lines)).toBe(2);
  });

  it("handles shebang + use client with a blank line between", () => {
    const lines = ["#!/usr/bin/env node", "", '"use client";', "code();"];
    expect(prologueEnd(lines)).toBe(3);
  });

  it("is zero when there is no prologue", () => {
    expect(prologueEnd(["const x = 1;"])).toBe(0);
  });
});

describe("prependIntoSource", () => {
  it("inserts after a shebang + directive, preserving them at the top", () => {
    const src = '#!/usr/bin/env node\n"use strict";\nstartServer();\n';
    const out = prependIntoSource(src, BLOCK);
    const lines = out.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).toBe('"use strict";');
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe('import { Crumbtrail } from "crumbtrail-core";');
    // original body still present after the block
    expect(out).toContain("startServer();");
    // block precedes the original body
    expect(out.indexOf("Crumbtrail.init")).toBeLessThan(
      out.indexOf("startServer"),
    );
  });

  it("preserves CRLF line endings", () => {
    const src = '"use client";\r\nrender();\r\n';
    const out = prependIntoSource(src, BLOCK);
    expect(out).toContain("\r\n");
    // no lone LF introduced
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(out.startsWith('"use client";\r\n')).toBe(true);
  });

  it("preserves a leading BOM", () => {
    const src = "﻿const a = 1;\n";
    const out = prependIntoSource(src, BLOCK);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    // BOM only appears once, at the very start
    expect(out.slice(1)).not.toContain("﻿");
  });

  it("puts the block first when there is no prologue", () => {
    const out = prependIntoSource("render();\n", BLOCK);
    expect(out.startsWith("import { Crumbtrail }")).toBe(true);
  });
});

describe("analyzeSource / referencesCrumbtrail", () => {
  it("detects CRLF and BOM", () => {
    const s = analyzeSource("﻿a\r\nb");
    expect(s.bom).toBe("﻿");
    expect(s.eol).toBe("\r\n");
    expect(s.lines).toEqual(["a", "b"]);
  });

  it("flags crumbtrail references", () => {
    expect(referencesCrumbtrail('import x from "crumbtrail-node";')).toBe(true);
    expect(referencesCrumbtrail("import x from 'crumbtrail-core';")).toBe(true);
    expect(referencesCrumbtrail('import("crumbtrail-core");')).toBe(true);
    expect(referencesCrumbtrail('require("crumbtrail-node");')).toBe(true);
    expect(referencesCrumbtrail("nothing here")).toBe(false);
  });

  it("ignores package names in comments, strings, and unrelated config", () => {
    expect(
      referencesCrumbtrail(
        [
          '// import x from "crumbtrail-core";',
          '/* require("crumbtrail-node") */',
          'const config = { package: "crumbtrail-core" };',
          'const text = "crumbtrail-react-native";',
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("rejects member loaders while keeping bare module loaders executable", () => {
    expect(referencesCrumbtrail('window.import("crumbtrail-core");')).toBe(
      false,
    );
    expect(referencesCrumbtrail('loader.require("crumbtrail-node");')).toBe(
      false,
    );
    expect(referencesCrumbtrail('import("crumbtrail-core");')).toBe(true);
    expect(referencesCrumbtrail('require("crumbtrail-node");')).toBe(true);
  });

  it("flags the Dart package, whose name has no hyphen", () => {
    // Missing this would re-wire an already-wired Flutter app on every re-run.
    expect(
      referencesCrumbtrail(
        "import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';",
      ),
    ).toBe(true);
  });
});

const IMPORT_LINE =
  "import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';";
const INIT_LINES = [
  "await Crumbtrail.start(const CrumbtrailConfig(",
  "  endpoint: 'https://ingest.example.com',",
  "));",
];

describe("wireFlutterMain", () => {
  it("makes a synchronous main async and starts capture before runApp", () => {
    const src = [
      "import 'package:flutter/material.dart';",
      "",
      "void main() {",
      "  runApp(const MyApp());",
      "}",
      "",
    ].join("\n");
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    expect(out).not.toBeNull();
    // Future<void>, not `void`: an async void main cannot be awaited by
    // anything and Dart's own lints flag it.
    expect(out).toContain("Future<void> main() async {");
    expect(out).not.toContain("void main() {");
    expect(out).toContain(IMPORT_LINE);
    // Capture must be running before the first frame, or the errors thrown
    // during startup — the ones hardest to reproduce — are simply not seen.
    expect(out.indexOf("Crumbtrail.start")).toBeLessThan(out.indexOf("runApp"));
    expect(out.indexOf(IMPORT_LINE)).toBeLessThan(out.indexOf("main()"));
  });

  it("leaves an already-async main's signature alone", () => {
    const src = [
      "import 'package:flutter/material.dart';",
      "",
      "Future<void> main() async {",
      "  await setup();",
      "  runApp(const MyApp());",
      "}",
      "",
    ].join("\n");
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    expect(out).toContain("Future<void> main() async {");
    // Inserted first, so capture is live before the app's own async setup —
    // which is code that can itself throw.
    expect(out.indexOf("Crumbtrail.start")).toBeLessThan(
      out.indexOf("await setup();"),
    );
  });

  it("handles `void main() async`", () => {
    const src = "void main() async {\n  runApp(const MyApp());\n}\n";
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    expect(out).toContain("void main() async {");
    expect(out).toContain("Crumbtrail.start");
  });

  it("indents the inserted call to match the main it found", () => {
    const src = "void main() {\n  runApp(const MyApp());\n}\n";
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    expect(out).toContain("  await Crumbtrail.start(const CrumbtrailConfig(");
    expect(out).toContain("    endpoint: 'https://ingest.example.com',");
  });

  it("puts the import after existing directives, never above them", () => {
    // Dart requires directives before declarations, and a `library` line has to
    // stay first — inserting above it would not compile.
    const src = [
      "library my_app;",
      "",
      "import 'package:flutter/material.dart';",
      "import 'src/home.dart';",
      "",
      "void main() {",
      "  runApp(const MyApp());",
      "}",
      "",
    ].join("\n");
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    const lines = out.split("\n");
    expect(lines[0]).toBe("library my_app;");
    expect(lines.indexOf(IMPORT_LINE)).toBe(
      lines.indexOf("import 'src/home.dart';") + 1,
    );
  });

  it("declines an arrow-bodied main rather than guessing", () => {
    // A near-miss edit here either fails to compile or, worse, compiles and
    // captures nothing. Guidance is the better answer.
    const src = "void main() => runApp(const MyApp());\n";
    expect(wireFlutterMain(src, IMPORT_LINE, INIT_LINES)).toBeNull();
  });

  it("declines a main that takes arguments", () => {
    const src = "void main(List<String> args) {\n  runApp(const MyApp());\n}\n";
    expect(wireFlutterMain(src, IMPORT_LINE, INIT_LINES)).toBeNull();
  });

  it("declines when more than one main is present", () => {
    const src = [
      "void main() {",
      "  runApp(const MyApp());",
      "}",
      "",
      "void main() {",
      "  runApp(const OtherApp());",
      "}",
      "",
    ].join("\n");
    expect(wireFlutterMain(src, IMPORT_LINE, INIT_LINES)).toBeNull();
  });

  it("declines a file with no main at all", () => {
    expect(
      wireFlutterMain("class Foo {}\n", IMPORT_LINE, INIT_LINES),
    ).toBeNull();
  });

  it("preserves CRLF line endings", () => {
    const src =
      "import 'package:flutter/material.dart';\r\nvoid main() {\r\n  runApp(const MyApp());\r\n}\r\n";
    const out = wireFlutterMain(src, IMPORT_LINE, INIT_LINES)!;
    expect(out).toContain("\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});
