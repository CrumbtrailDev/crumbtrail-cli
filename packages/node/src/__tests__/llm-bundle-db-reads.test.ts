import { describe, expect, it } from "vitest";
import { renderDatabaseReadSection } from "../llm-bundle";

/**
 * `databaseReads` was built, redacted and written to `bundle.json` all along, and the markdown a
 * reader is handed printed none of it. Rendering only rows that CHANGED assumes the defect is
 * something the application did; a promotion whose validity window is stored back to front is
 * something it read.
 */
describe("Database Rows Read", () => {
  type Read = Parameters<typeof renderDatabaseReadSection>[0][number];

  function read(t: number, table: string, row: Record<string, unknown>): Read {
    return {
      t,
      offsetMs: t,
      engine: "postgres",
      table,
      pk: null,
      row,
      requestId: "r1",
    } as unknown as Read;
  }

  it("renders nothing when the session read nothing", () => {
    expect(renderDatabaseReadSection([])).toEqual([]);
  });

  it("prints the row a request read", () => {
    const markdown = renderDatabaseReadSection([
      read(10, "coupons", {
        code: "NIGHTLY",
        valid_from: "2026-07-19T00:00:00.000Z",
        valid_until: "2026-07-18T00:00:00.000Z",
      }),
    ]).join("\n");

    expect(markdown).toContain("coupons");
    expect(markdown).toContain("2026-07-18");
  });

  it("collapses a row read over and over into one line", () => {
    const same = { id: 1, price_cents: 19900 };
    const markdown = renderDatabaseReadSection([
      read(10, "products", same),
      read(20, "products", same),
      read(30, "products", same),
    ]).join("\n");

    expect(markdown.match(/19900/g)).toHaveLength(1);
  });

  // The same row at two different values is two facts, not one repeated.
  it("keeps a row whose value changed between reads", () => {
    const markdown = renderDatabaseReadSection([
      read(10, "cards", { id: 1, balance_cents: 5000 }),
      read(20, "cards", { id: 1, balance_cents: 1250 }),
    ]).join("\n");

    expect(markdown).toContain("5000");
    expect(markdown).toContain("1250");
  });

  // A catalogue read returns forty rows and a coupon lookup returns one. Under a flat cap the
  // catalogue spends every slot and the row the session turned on is dropped.
  it("does not let one wide read crowd out a single decisive row", () => {
    const catalogue = Array.from({ length: 40 }, (_, i) =>
      read(i, "products", { id: i, name: `product-${i}` }),
    );
    const markdown = renderDatabaseReadSection([
      ...catalogue,
      read(999, "coupons", { code: "NIGHTLY", valid_until: "2026-07-18" }),
    ]).join("\n");

    expect(markdown).toContain("NIGHTLY");
  });

  it("says how many distinct rows it left in bundle.json", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      read(i, `table_${i % 30}`, { id: i }),
    );

    expect(renderDatabaseReadSection(many).join("\n")).toContain(
      "further distinct row(s) are in",
    );
  });
});
