import { describe, expect, it } from "vitest";
import {
  analyzeSource,
  prependIntoSource,
  prologueEnd,
  referencesCrumbtrail,
} from "../inject/text";

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
    expect(referencesCrumbtrail("nothing here")).toBe(false);
  });
});
