import { describe, expect, it } from "vitest";
import { instrumentPgClient } from "../db/pg";
import { instrumentMysqlClient } from "../db/mysql";
import { DB_RELATIONAL_ORDER_EVENT_KIND, type BugEvent } from "crumbtrail-core";
import {
  emitRelationalOrderEvents,
  emitRelationalOrderAttempt,
  MAX_RELATIONAL_ORDER_DECLARATIONS,
  MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST,
  nextRelationalOrderSequence,
  type RelationalOrderCaptureOptions,
} from "../db/relational-order";

const declaration = {
  relationId: "order-line-order",
  parent: { table: "orders", columns: ["id"] },
  child: { table: "order_lines", columns: ["order_id"] },
  childNullable: [false],
  constraintTiming: "immediate" as const,
  deferrable: false,
};

function options(
  overrides: Partial<RelationalOrderCaptureOptions> = {},
  events: BugEvent[] = [],
): {
  relationalOrder: RelationalOrderCaptureOptions;
  emit: (event: BugEvent) => void;
} {
  return {
    relationalOrder: {
      key: "test-only-key-with-at-least-32-bytes",
      declarations: [declaration],
      ...overrides,
    },
    emit: (event) => events.push(event),
  };
}

function capture(
  table: string,
  row: Record<string, unknown>,
  overrides: Partial<RelationalOrderCaptureOptions> = {},
): BugEvent[] {
  const events: BugEvent[] = [];
  const input = options(overrides, events);
  emitRelationalOrderEvents({
    engine: "postgres",
    op: "insert",
    table,
    requestId: "request-1",
    rows: [row],
    options: input,
    sequence: table === "order_lines" ? 1 : 2,
    transactionId: "dbtx-1",
  });
  return events;
}

describe("explicit relational order capture", () => {
  it("retains each mutation ordinal when MySQL image reads finish out of order", async () => {
    const events: BugEvent[] = [];
    const imageResolvers = new Map<number, (result: unknown) => void>();
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstImage = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondImage = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const client = instrumentMysqlClient(
      {
        async query(text: string, params?: unknown[]) {
          const id = Number(params?.[0]);
          if (text.startsWith("SELECT")) {
            return new Promise<unknown>((resolve) => {
              imageResolvers.set(id, resolve);
              if (id === 42) firstStarted();
              else secondStarted();
            });
          }
          return [{ affectedRows: 1, insertId: id }, []];
        },
      },
      { ...options({}, events), requestId: "request-1" },
    );
    const first = client.query("INSERT INTO orders (id) VALUES (?)", [42]);
    await firstImage;
    const second = client.query("INSERT INTO orders (id) VALUES (?)", [43]);
    await secondImage;
    imageResolvers.get(43)!([[{ id: 43 }], []]);
    await second;
    imageResolvers.get(42)!([[{ id: 42 }], []]);
    await first;
    const observations = events.filter(
      (event) => event.k === DB_RELATIONAL_ORDER_EVENT_KIND,
    );
    expect(observations.map((event) => event.d.sequence)).toEqual([2, 1]);
    expect(observations.map((event) => event.d.valueIdentity)).toEqual([
      capture("orders", { id: 43 })[0].d.valueIdentity,
      capture("orders", { id: 42 })[0].d.valueIdentity,
    ]);
  });

  it("never reuses statement ordinals after request churn", () => {
    const input = options();
    expect(nextRelationalOrderSequence(input, "request-1")).toBe(1);
    for (let index = 0; index < 300; index += 1)
      nextRelationalOrderSequence({ ...input }, `other-${index}`);
    expect(nextRelationalOrderSequence(input, "request-1")).toBe(302);
  });
  it("binds failed statements exactly and preserves sequence, budget, and generation across option copies", async () => {
    const events: BugEvent[] = [];
    const generations: unknown[] = [];
    const generation = Symbol("session");
    const input = options({ maxEventsPerRequest: 2 }, events);
    const client = instrumentPgClient(
      {
        async query(text: unknown) {
          if (String(text).includes("order_lines"))
            throw Object.assign(new Error("refused"), { code: "23503" });
          return { rows: [{ id: 42 }], rowCount: 1 };
        },
      },
      {
        ...input,
        requestId: "request-1",
        getCaptureGeneration: () => generation,
        emit(event, owner) {
          events.push(event);
          generations.push(owner);
        },
      },
    );
    await expect(
      client.query("INSERT INTO order_lines (order_id) VALUES ($1)"),
    ).rejects.toThrow("refused");
    // The parameterized attempt above lacks a bind and therefore supplies no identity.
    await client.query("INSERT INTO orders (id) VALUES (42)");
    await client.query("INSERT INTO orders (id) VALUES (42)");
    await client.query("INSERT INTO orders (id) VALUES (42)");
    const relational = events.filter(
      (event) => event.k === DB_RELATIONAL_ORDER_EVENT_KIND,
    );
    expect(relational.map((event) => event.d.sequence)).toEqual([2, 3]);
    expect(
      events.find((event) => event.k === "db.error")?.d.relationalSequence,
    ).toBe(1);
    expect(generations.every((owner) => owner === generation)).toBe(true);
  });

  it("joins the refused child and its error using the same ordinal before a successful parent", async () => {
    const events: BugEvent[] = [];
    const client = instrumentPgClient(
      {
        async query(text: unknown, _params?: unknown) {
          if (String(text).includes("order_lines"))
            throw Object.assign(new Error("refused"), { code: "23503" });
          return { rows: [{ id: 42 }], rowCount: 1 };
        },
      },
      { ...options({}, events), requestId: "request-1" },
    );
    await expect(
      client.query("INSERT INTO order_lines (order_id) VALUES ($1)", [42]),
    ).rejects.toThrow("refused");
    await client.query("INSERT INTO orders (id) VALUES ($1)", [42]);
    const relational = events.filter(
      (event) => event.k === DB_RELATIONAL_ORDER_EVENT_KIND,
    );
    expect(relational.map((event) => event.d.sequence)).toEqual([1, 2]);
    expect(
      events.find((event) => event.k === "db.error")?.d.relationalSequence,
    ).toBe(relational[0].d.sequence);
  });

  it("rejects weak keys and oversized identities and does not interpret expressions as SQL literals", () => {
    expect(capture("orders", { id: 42 }, { key: "short" })).toEqual([]);
    expect(capture("orders", { id: "x".repeat(20_000) })).toEqual([]);
    const events: BugEvent[] = [];
    emitRelationalOrderAttempt({
      engine: "postgres",
      op: "insert",
      table: "order_lines",
      statement: "INSERT INTO order_lines (order_id) VALUES ('a' || 'b')",
      requestId: "request-1",
      sequence: 1,
      options: options({}, events),
    });
    expect(events).toEqual([]);
  });

  it("seals matching parent and child values without resting schema or row data", () => {
    const child = capture("order_lines", {
      order_id: 42,
      secret: "never-rest",
    })[0];
    const parent = capture("orders", { id: 42, secret: "never-rest" })[0];

    expect(child?.k).toBe(DB_RELATIONAL_ORDER_EVENT_KIND);
    expect(child?.d).toMatchObject({
      role: "child",
      sequence: 1,
      requestId: "request-1",
      transactionId: "dbtx-1",
      contract: {
        version: 1,
        columnCount: 1,
        childNullable: [false],
        constraintTiming: "immediate",
        deferrable: false,
      },
    });
    expect(parent?.d).toMatchObject({ role: "parent", sequence: 2 });
    expect((child?.d as Record<string, unknown>).relationIdentity).toBe(
      (parent?.d as Record<string, unknown>).relationIdentity,
    );
    expect((child?.d as Record<string, unknown>).valueIdentity).toBe(
      (parent?.d as Record<string, unknown>).valueIdentity,
    );
    expect(Object.keys(child?.d as Record<string, unknown>).sort()).toEqual([
      "contract",
      "engine",
      "op",
      "relationIdentity",
      "requestId",
      "role",
      "sequence",
      "transactionId",
      "valueIdentity",
    ]);
    expect(JSON.stringify(child)).not.toContain("order_lines");
    expect(JSON.stringify(child)).not.toContain("order_id");
    expect(JSON.stringify(child)).not.toContain("never-rest");
    expect(Object.values(child?.d as Record<string, unknown>)).not.toContain(
      42,
    );
  });

  it("captures a parameterized failed child INSERT at the existing error seam", () => {
    const events: BugEvent[] = [];
    const input = options({}, events);
    emitRelationalOrderAttempt({
      engine: "postgres",
      op: "insert",
      table: "order_lines",
      statement: "INSERT INTO order_lines (order_id) VALUES ($1)",
      params: [42],
      requestId: "request-1",
      sequence: 1,
      transactionId: "dbtx-1",
      options: input,
    });
    expect(events).toHaveLength(1);
    expect((events[0].d as Record<string, unknown>).role).toBe("child");
    expect(JSON.stringify(events[0])).not.toContain("INSERT");
    expect(Object.values(events[0].d as Record<string, unknown>)).not.toContain(
      42,
    );
  });

  it("uses each positional bind once across a bounded multi-row failed INSERT", () => {
    const events: BugEvent[] = [];
    const input = options({}, events);
    emitRelationalOrderAttempt({
      engine: "mysql",
      op: "insert",
      table: "order_lines",
      statement: "INSERT INTO order_lines (order_id) VALUES (?), (?)",
      params: [41, 42],
      requestId: "request-1",
      sequence: 1,
      options: input,
    });

    expect(events).toHaveLength(2);
    const expected = [41, 42].map(
      (id) => capture("order_lines", { order_id: id })[0]?.d,
    );
    expect(
      events.map((event) => (event.d as Record<string, unknown>).valueIdentity),
    ).toEqual(
      expected.map((data) => (data as Record<string, unknown>).valueIdentity),
    );
  });

  it("is deterministic, domain-separated, and changes when the key or declaration changes", () => {
    const first = capture("orders", { id: 42 })[0]?.d as Record<
      string,
      unknown
    >;
    const second = capture("orders", { id: 42 })[0]?.d as Record<
      string,
      unknown
    >;
    const changedKey = capture(
      "orders",
      { id: 42 },
      { key: "different-key-with-at-least-32-bytes" },
    )[0]?.d as Record<string, unknown>;
    const changedDeclaration = capture(
      "orders",
      { id: 42 },
      {
        declarations: [{ ...declaration, relationId: "different-relation" }],
      },
    )[0]?.d as Record<string, unknown>;

    expect(first.relationIdentity).toBe(second.relationIdentity);
    expect(first.valueIdentity).toBe(second.valueIdentity);
    expect(first.relationIdentity).not.toBe(changedKey.relationIdentity);
    expect(first.valueIdentity).not.toBe(changedKey.valueIdentity);
    expect(first.relationIdentity).not.toBe(
      changedDeclaration.relationIdentity,
    );
    expect(first.relationIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.valueIdentity).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("stays silent for null identities, hostile rows, deletes, and missing sequence", () => {
    const getter = Object.defineProperty({}, "order_id", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const proxy = new Proxy(
      { order_id: 42 },
      {
        getOwnPropertyDescriptor() {
          throw new Error("hostile proxy");
        },
      },
    );
    expect(capture("order_lines", { order_id: null })).toHaveLength(0);
    expect(capture("order_lines", getter)).toHaveLength(0);
    expect(capture("order_lines", proxy)).toHaveLength(0);

    const events: BugEvent[] = [];
    const input = options({}, events);
    emitRelationalOrderEvents({
      engine: "postgres",
      op: "delete",
      table: "orders",
      requestId: "request-1",
      rows: [{ id: 42 }],
      options: input,
      transactionId: "dbtx-1",
    });
    expect(events).toHaveLength(0);

    emitRelationalOrderAttempt({
      engine: "postgres",
      op: "insert",
      table: "orders",
      statement:
        "INSERT INTO order_lines (order_id) VALUES ($1); DROP TABLE orders",
      params: [42],
      requestId: "request-1",
      sequence: 1,
      options: input,
    });
    emitRelationalOrderAttempt({
      engine: "postgres",
      op: "insert",
      table: "order_lines",
      statement: "INSERT INTO order_lines (order_id) VALUES ($1)",
      params: [42],
      requestId: "\u0000bad",
      sequence: 1,
      options: input,
    });
    expect(events).toHaveLength(0);
  });

  it("rejects an internally inconsistent deferred declaration", () => {
    expect(
      capture(
        "orders",
        { id: 42 },
        {
          declarations: [
            { ...declaration, constraintTiming: "deferred", deferrable: false },
          ],
        },
      ),
    ).toHaveLength(0);
  });

  it("enforces declaration and per-request event bounds", () => {
    const tooMany = Array.from(
      { length: MAX_RELATIONAL_ORDER_DECLARATIONS + 1 },
      (_, index) => ({
        ...declaration,
        relationId: `r-${index}`,
      }),
    );
    expect(
      capture("orders", { id: 42 }, { declarations: tooMany }),
    ).toHaveLength(0);

    const events: BugEvent[] = [];
    const input = options(
      {
        declarations: Array.from({ length: 32 }, (_, index) => ({
          ...declaration,
          relationId: `r-${index}`,
        })),
        maxEventsPerRequest: MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST + 10,
      },
      events,
    );
    emitRelationalOrderEvents({
      engine: "postgres",
      op: "insert",
      table: "orders",
      requestId: "request-1",
      rows: Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })),
      options: input,
      sequence: 1,
    });
    expect(events).toHaveLength(MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST);
  });
});
