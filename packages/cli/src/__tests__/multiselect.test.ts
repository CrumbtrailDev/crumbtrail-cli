import { describe, expect, it } from "vitest";
import { parseSelection, type MultiSelectItem } from "../ui";

const items: MultiSelectItem[] = [
  { label: "apps/web", checked: true, selectable: true },
  { label: "services/api", checked: true, selectable: true },
  { label: "services/payments", checked: false, selectable: true },
  { label: "packages/tsconfig", checked: false, selectable: false },
];

function indices(input: string): number[] {
  const r = parseSelection(input, items);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.indices;
}

function error(input: string): string {
  const r = parseSelection(input, items);
  if (r.ok) throw new Error(`expected an error, got: ${r.indices}`);
  return r.error;
}

describe("parseSelection", () => {
  it("takes the checked defaults on empty input", () => {
    expect(indices("")).toEqual([0, 1]);
    expect(indices("   ")).toEqual([0, 1]);
  });

  it("handles all / none", () => {
    // "all" means every SELECTABLE row — never the unwireable one.
    expect(indices("all")).toEqual([0, 1, 2]);
    expect(indices("none")).toEqual([]);
  });

  it("parses lists, ranges, and mixed separators", () => {
    expect(indices("1,3")).toEqual([0, 2]);
    expect(indices("1-3")).toEqual([0, 1, 2]);
    expect(indices("1-2, 3")).toEqual([0, 1, 2]);
    expect(indices("3 1")).toEqual([0, 2]);
  });

  it("dedupes overlapping picks", () => {
    expect(indices("1,1,1-2")).toEqual([0, 1]);
  });

  it("rejects garbage rather than silently dropping it", () => {
    expect(error("web")).toContain("isn't a number");
    expect(error("1,web")).toContain("isn't a number");
  });

  it("rejects out-of-range and inverted ranges", () => {
    expect(error("0")).toContain("out of range");
    expect(error("9")).toContain("out of range");
    expect(error("3-1")).toContain("out of range");
  });

  it("rejects an unselectable row by name, so the user learns why", () => {
    const message = error("4");
    expect(message).toContain("packages/tsconfig");
    expect(message).toContain("no supported framework");
  });
});
