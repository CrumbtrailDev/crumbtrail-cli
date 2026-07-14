import { describe, it, expect } from "vitest";
import { parseMutation, parseRead } from "../db";

describe("parseMutation", () => {
  it("parses a simple INSERT statement", () => {
    expect(
      parseMutation("INSERT INTO users (id, name) VALUES ($1, $2)"),
    ).toEqual({
      op: "insert",
      table: "users",
    });
  });

  it("parses an UPDATE statement and extracts the WHERE clause", () => {
    const result = parseMutation("UPDATE users SET name = 'Ada' WHERE id = 7");
    expect(result?.op).toBe("update");
    expect(result?.table).toBe("users");
    expect(result?.whereClause).toBe("WHERE id = 7");
  });

  it("parses a DELETE statement and extracts the WHERE clause", () => {
    const result = parseMutation(
      "DELETE FROM sessions WHERE expired_at < now()",
    );
    expect(result?.op).toBe("delete");
    expect(result?.table).toBe("sessions");
    expect(result?.whereClause).toBe("WHERE expired_at < now()");
  });

  it("strips double-quoted identifiers from the table name", () => {
    expect(parseMutation('INSERT INTO "Order Items" (id) VALUES ($1)')).toEqual(
      {
        op: "insert",
        table: "Order Items",
      },
    );
  });

  it("handles schema-qualified table names", () => {
    expect(
      parseMutation("UPDATE public.users SET active = false WHERE id = 1"),
    ).toMatchObject({
      op: "update",
      table: "public.users",
    });
  });

  it("handles UPDATE ONLY / DELETE FROM ONLY (inheritance exclusion)", () => {
    expect(
      parseMutation("UPDATE ONLY users SET active = false WHERE id = 1"),
    ).toMatchObject({
      op: "update",
      table: "users",
    });
    expect(parseMutation("DELETE FROM ONLY users WHERE id = 1")).toMatchObject({
      op: "delete",
      table: "users",
    });
  });

  it("stops the WHERE clause before a trailing RETURNING clause", () => {
    const result = parseMutation(
      "UPDATE users SET name = 'Ada' WHERE id = 7 RETURNING *",
    );
    expect(result?.whereClause?.trim()).toBe("WHERE id = 7");
  });

  it("returns undefined for statements without a WHERE clause", () => {
    const result = parseMutation("DELETE FROM sessions");
    expect(result?.whereClause).toBeUndefined();
  });

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseMutation("  insert into users (id) values ($1)")).toEqual({
      op: "insert",
      table: "users",
    });
  });

  it("returns undefined for SELECT statements", () => {
    expect(parseMutation("SELECT * FROM users WHERE id = 1")).toBeUndefined();
  });

  it("returns undefined for non-SQL / malformed input", () => {
    expect(parseMutation("")).toBeUndefined();
    expect(parseMutation("not sql at all")).toBeUndefined();
    expect(parseMutation("BEGIN")).toBeUndefined();
    expect(parseMutation("COMMIT")).toBeUndefined();
  });
});

describe("parseRead", () => {
  it("parses the table from a simple SELECT statement", () => {
    expect(parseRead("SELECT * FROM users WHERE id = 1")).toEqual({
      table: "users",
    });
  });

  it("parses the table from a SELECT with explicit columns and joins", () => {
    expect(
      parseRead(
        "SELECT id, name FROM users JOIN orders ON orders.user_id = users.id",
      ),
    ).toEqual({
      table: "users",
    });
  });

  it("returns undefined for non-SELECT statements", () => {
    expect(parseRead("INSERT INTO users (id) VALUES (1)")).toBeUndefined();
    expect(parseRead("UPDATE users SET name = 1")).toBeUndefined();
    expect(parseRead("")).toBeUndefined();
  });
});
