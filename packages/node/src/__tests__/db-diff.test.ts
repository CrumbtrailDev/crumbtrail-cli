import { describe, it, expect } from "vitest";
import { createCrumbtrailRequestHeaders } from "crumbtrail-core";
import type { BugEvent, DbDiffEventData } from "crumbtrail-core";
import { buildBackendRequestErrorEvent } from "../backend-events";
import {
  buildDbDiffEvent,
  instrumentPgClient,
  resolveDbRequestContext,
  DEFAULT_SENSITIVE_DB_COLUMNS,
} from "../db";

/** A fake duck-typed pg client that returns canned rows and records every query. */
function fakePgClient(
  handler: (
    text: string,
    params?: unknown[],
  ) => { rows: unknown[]; rowCount?: number },
) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return Promise.resolve(handler(text, params));
    },
  };
}

describe("buildDbDiffEvent", () => {
  it("builds the canonical db.diff event correlated by requestId", () => {
    const event = buildDbDiffEvent({
      op: "insert",
      table: "orders",
      pk: { id: 42 },
      after: { id: 42, total: 100 },
      requestId: "trace-xyz",
      sessionId: "ses_1",
      now: 1_700_000_000_500,
      sessionStartedAt: 1_700_000_000_000,
    });

    expect(event.k).toBe("db.diff");
    expect(event.t).toBe(1_700_000_000_500);
    expect(event.sessionId).toBe("ses_1");
    expect(event.offsetMs).toBe(500);
    const d = event.d as unknown as DbDiffEventData;
    expect(d).toMatchObject({
      engine: "postgres",
      op: "insert",
      table: "orders",
      requestId: "trace-xyz",
    });
    expect(d.pk).toEqual({ id: 42 });
    expect(d.after).toEqual({ id: 42, total: 100 });
  });

  it("redacts sensitive column values before the event rests", () => {
    const event = buildDbDiffEvent({
      op: "update",
      table: "users",
      pk: { id: 7 },
      after: {
        id: 7,
        email: "a@b.com",
        password: "hunter2-super-secret",
        api_key: "sk_fake_zzzzzzzzzzzzzzzzzz",
      },
      requestId: "r1",
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("hunter2-super-secret");
    expect(serialized).not.toContain("sk_fake_zzzzzzzzzzzzzzzzzz");
    const d = event.d as unknown as DbDiffEventData;
    expect(d.after!.password).toBe("[REDACTED]");
    expect(d.after!.api_key).toBe("[REDACTED]");
    expect(d.after!.id).toBe(7);
  });

  it("truncates an oversized column value with a clear marker before the event rests", () => {
    // Prose (not token-like) so it survives redaction and exercises the size cap, not redaction.
    const huge = "the quick brown fox jumps over the lazy dog. ".repeat(500); // 22_500 chars
    const event = buildDbDiffEvent({
      op: "update",
      table: "docs",
      pk: { id: 1 },
      after: { id: 1, body: huge },
      requestId: "r1",
    });
    const d = event.d as unknown as DbDiffEventData;
    const bounded = d.after!.body as string;
    expect(bounded.length).toBeLessThan(huge.length);
    expect(bounded.length).toBeLessThanOrEqual(8 * 1024 + 40);
    expect(bounded.startsWith(huge.slice(0, 8 * 1024))).toBe(true);
    expect(bounded).toContain(`[truncated ${huge.length} chars]`);
    // The full untruncated value must never rest in the serialized event.
    expect(JSON.stringify(event).includes(huge)).toBe(false);
  });

  it("exposes the default sensitive column list", () => {
    expect(DEFAULT_SENSITIVE_DB_COLUMNS).toEqual([
      "password",
      "token",
      "secret",
      "api_key",
      "ssn",
    ]);
  });
});

describe("instrumentPgClient", () => {
  it("records an INSERT as a db.diff with op, table, pk and after-image", async () => {
    const client = fakePgClient(() => ({
      rows: [{ id: 1, name: "Ada" }],
      rowCount: 1,
    }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-1",
      sessionId: "ses",
      emit: (e) => events.push(e),
    });

    await db.query("INSERT INTO orders (name) VALUES ($1)", ["Ada"]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toEqual({ id: 1 });
    expect(d.after).toEqual({ id: 1, name: "Ada" });
    expect(d.requestId).toBe("req-1");
    // The shim appends RETURNING * so it can read the after-image.
    expect(client.calls[0].text).toMatch(/returning \*/i);
  });

  it("records a DELETE with the removed row as the before-image and no after", async () => {
    const client = fakePgClient(() => ({
      rows: [{ id: 9, name: "gone" }],
      rowCount: 1,
    }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-d",
      emit: (e) => events.push(e),
    });

    await db.query("DELETE FROM widgets WHERE id = $1", [9]);

    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("delete");
    expect(d.table).toBe("widgets");
    expect(d.before).toEqual({ id: 9, name: "gone" });
    expect(d.after).toBeUndefined();
  });

  it("captures the pre-image for an UPDATE when captureBefore is enabled", async () => {
    const client = fakePgClient((text) =>
      /^select/i.test(text)
        ? { rows: [{ id: 3, status: "pending" }] }
        : { rows: [{ id: 3, status: "shipped" }], rowCount: 1 },
    );
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-u",
      captureBefore: true,
      emit: (e) => events.push(e),
    });

    await db.query("UPDATE orders SET status = $1 WHERE id = $2", [
      "shipped",
      3,
    ]);

    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("update");
    expect(d.before).toEqual({ id: 3, status: "pending" });
    expect(d.after).toEqual({ id: 3, status: "shipped" });
    // A pre-image SELECT ran before the mutation.
    expect(client.calls[0].text).toMatch(/^select \* from orders/i);
  });

  it("does not emit or alter non-mutating SELECT statements", async () => {
    const client = fakePgClient(() => ({ rows: [{ id: 1 }] }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "r",
      emit: (e) => events.push(e),
    });

    await db.query("SELECT * FROM users WHERE id = $1", [1]);

    expect(events).toHaveLength(0);
    expect(client.calls[0].text).toBe("SELECT * FROM users WHERE id = $1");
  });

  it("skips emission when no request scope is active (no correlation id)", async () => {
    const client = fakePgClient(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      getRequestId: () => undefined,
      emit: (e) => events.push(e),
    });

    await db.query("INSERT INTO t (a) VALUES ($1)", [1]);
    expect(events).toHaveLength(0);
  });

  it("still runs the mutation and returns the real result when captureBefore SELECT throws", async () => {
    // Instrumentation must be strictly non-intrusive: a failing pre-image SELECT (bad WHERE,
    // permissions, etc.) must NOT abort a mutation that would otherwise succeed.
    const client = {
      calls: [] as Array<{ text: string; params?: unknown[] }>,
      query(text: string, params?: unknown[]) {
        this.calls.push({ text, params });
        if (/^select/i.test(text))
          return Promise.reject(
            new Error("permission denied for table orders"),
          );
        return Promise.resolve({
          rows: [{ id: 3, status: "shipped" }],
          rowCount: 1,
        });
      },
    };
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "req-u",
      captureBefore: true,
      emit: (e) => events.push(e),
    });

    const result = await db.query(
      "UPDATE orders SET status = $1 WHERE id = $2",
      ["shipped", 3],
    );

    // The mutation succeeded and the host gets the real, unchanged result.
    expect(result).toEqual({
      rows: [{ id: 3, status: "shipped" }],
      rowCount: 1,
    });
    // A diff was still emitted, just without a before-image.
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("update");
    expect(d.after).toEqual({ id: 3, status: "shipped" });
    expect(d.before).toBeUndefined();
  });

  it("does not break the host query when emission throws", async () => {
    const client = fakePgClient(() => ({
      rows: [{ id: 1, name: "Ada" }],
      rowCount: 1,
    }));
    const db = instrumentPgClient(client, {
      requestId: "req-1",
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    // A failing emit must degrade to "no diff emitted", never propagate to the caller's query.
    const result = await db.query("INSERT INTO orders (name) VALUES ($1)", [
      "Ada",
    ]);
    expect(result).toEqual({ rows: [{ id: 1, name: "Ada" }], rowCount: 1 });
  });

  it("redacts a secret column captured from a RETURNING row", async () => {
    const client = fakePgClient(() => ({
      rows: [{ id: 5, token: "tok_secret_value_should_vanish" }],
      rowCount: 1,
    }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      requestId: "r",
      emit: (e) => events.push(e),
    });

    await db.query("INSERT INTO sessions (token) VALUES ($1)", ["x"]);
    expect(JSON.stringify(events[0])).not.toContain(
      "tok_secret_value_should_vanish",
    );
  });
});

describe("correlation reuse", () => {
  it("a mutating request yields a db.diff with the SAME requestId as the failing backend response", async () => {
    // The browser sets X-Crumbtrail-Request-Id = the W3C trace id; backend.req.* and db.diff
    // both resolve their correlation id from that same header.
    const headers = createCrumbtrailRequestHeaders(
      "ses_corr",
      "trace-shared-id",
    );

    const errorEvent = buildBackendRequestErrorEvent({
      headers,
      method: "POST",
      url: "/api/checkout",
      statusCode: 500,
      error: new Error("boom"),
    });

    const ctx = resolveDbRequestContext({ headers });
    const client = fakePgClient(() => ({
      rows: [{ id: 1, paid: false }],
      rowCount: 1,
    }));
    const events: BugEvent[] = [];
    const db = instrumentPgClient(client, {
      ...ctx,
      emit: (e) => events.push(e),
    });
    await db.query("UPDATE orders SET paid = $1 WHERE id = $2", [false, 1]);

    const dbRequestId = (events[0].d as unknown as DbDiffEventData).requestId;
    expect(dbRequestId).toBe(errorEvent.d.requestId);
    expect(dbRequestId).toBe("trace-shared-id");
    expect((events[0].d as unknown as DbDiffEventData).pk).toEqual({ id: 1 });
  });
});
