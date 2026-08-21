import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_FONT_STACK, BRAND_MONO_STACK } from "../brand-type";

const REPO = path.resolve(__dirname, "../../../..");

/**
 * Every surface in this repository that renders type outside a page the design
 * system styles. Each one used to name its own system stack; a literal here is
 * how that comes back.
 */
const SURFACES = [
  "packages/core/src/widget/styles.ts",
  "packages/node/src/server.ts",
  "packages/cli/src/auth.ts",
];

describe("brand type stacks", () => {
  it("names the same faces as the design system tokens", () => {
    // Face for face with --ds-font-body / --ds-font-mono in the main product
    // repository. That repository is not a dependency of this one, so this
    // asserts the value rather than reading the token; the design system's own
    // guard fails on its side if the token moves and this does not.
    expect(BRAND_FONT_STACK).toBe(
      "Roobert, Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    );
    expect(BRAND_MONO_STACK).toBe("ui-monospace, SFMono-Regular, Menlo, monospace");
  });

  it.each(SURFACES)("%s sets font-family from the shared stack", (relative) => {
    const source = readFileSync(path.join(REPO, relative), "utf8");
    const declarations = source.match(/font-family\s*:\s*[^;`]+/g) ?? [];

    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      // `inherit` is a deliberate non-decision: inside the widget's shadow
      // root it takes whatever :host already resolved, which is the shared
      // stack. Anything else naming faces by hand is drift.
      if (/font-family\s*:\s*inherit\s*$/.test(declaration)) continue;
      expect(declaration).toMatch(/\$\{BRAND_(?:FONT|MONO)_STACK\}/);
    }
  });
});
