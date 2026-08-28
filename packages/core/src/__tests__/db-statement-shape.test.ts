import { describe, expect, it } from "vitest";

import { normalizeStatementShape } from "../db-statement-shape";

/**
 * The contract this file exists to hold: a shape may contain SQL keywords,
 * identifiers and placeholders, and NOTHING ELSE.
 *
 * These are written as escapes rather than as examples, because the value of
 * the contract is entirely in what it refuses. Every case below is a way a
 * literal could try to reach evidence by being spelled unusually, and the MySQL
 * hash comment is here because it worked: `SELECT x FROM t # alice@example.com`
 * normalized to itself, address included.
 */
const SECRET = "alice@example.com";

describe("normalizeStatementShape holds a value-free contract", () => {
  const escapes: [string, string][] = [
    ["single-quoted literal", `SELECT * FROM users WHERE email = '${SECRET}'`],
    ["doubled-quote escape", `SELECT * FROM t WHERE a = 'O''Brien ${SECRET}'`],
    ["dollar-quoted body", `SELECT * FROM t WHERE a = $$${SECRET}$$`],
    ["tagged dollar-quoted body", `SELECT * FROM t WHERE a = $tag$${SECRET}$tag$`],
    ["double-quoted token", `SELECT * FROM t WHERE a = "${SECRET}"`],
    ["backtick-quoted token", `SELECT * FROM t WHERE a = \`${SECRET}\``],
    ["bracket-quoted token", `SELECT * FROM t WHERE a = [${SECRET}]`],
    ["line comment", `SELECT x FROM t -- ${SECRET}`],
    ["block comment", `SELECT x /* ${SECRET} */ FROM t`],
    ["hash comment", `SELECT x FROM t # ${SECRET}`],
    ["hash comment after a predicate", `SELECT x FROM t WHERE id = 1 # ${SECRET}`],
    ["hash comment with no space", `SELECT x FROM t #${SECRET}`],
    ["unbalanced quoting", `SELECT * FROM t WHERE n LIKE '%${SECRET}`],
  ];

  for (const [name, sql] of escapes) {
    it(`removes a value spelled as a ${name}`, () => {
      const shape = normalizeStatementShape(sql);
      expect(shape).not.toContain(SECRET);
      expect(shape).not.toContain("alice");
      expect(shape).not.toContain("example.com");
    });
  }

  it("removes numeric literals, which are values too", () => {
    expect(normalizeStatementShape("SELECT * FROM orders WHERE total = 23319")).not.toContain(
      "23319",
    );
    expect(normalizeStatementShape("SELECT * FROM t WHERE a = 0xDEADBEEF")).not.toContain(
      "DEADBEEF",
    );
  });

  it("keeps the structure a reader needs", () => {
    // The whole reason the shape is carried at all: it names the operation, the
    // table and the predicate form, which is what says WHAT went wrong.
    expect(
      normalizeStatementShape("SELECT enabled FROM feature_flags WHERE name = ANY($1)"),
    ).toBe("SELECT enabled FROM feature_flags WHERE name = ANY(?)");
  });

  it("keeps a jsonb path operator, which is structure and not a comment", () => {
    // `#` is a Postgres operator as well as a MySQL comment marker. The
    // two-character forms are unambiguous and must survive.
    for (const operator of ["#>", "#>>", "#-"]) {
      const shape = normalizeStatementShape(
        `SELECT data ${operator} '{a}' FROM t WHERE id = $1`,
      );
      expect(shape).toContain(operator);
      expect(shape).toContain("FROM t");
    }
  });

  it("discards the rest of the line after a bare hash, rather than guessing", () => {
    // Genuinely ambiguous: MySQL comment or Postgres bitwise XOR. Resolved by
    // discarding, which costs structure and never a value.
    const shape = normalizeStatementShape("SELECT a # b FROM t");
    expect(shape).toBe("SELECT a");
  });

  it("answers empty for a non-string or empty input", () => {
    expect(normalizeStatementShape("")).toBe("");
    expect(normalizeStatementShape(undefined as unknown as string)).toBe("");
  });
});
