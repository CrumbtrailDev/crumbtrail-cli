import { describe, expect, it } from "vitest";
import {
  DB_RELATIONAL_ORDER_EVENT_KIND,
  type BugEvent,
} from "crumbtrail-core";
import {
  emitRelationalOrderEvents,
  emitRelationalOrderAttempt,
  MAX_RELATIONAL_ORDER_DECLARATIONS,
  MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST,
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
): { relationalOrder: RelationalOrderCaptureOptions; emit: (event: BugEvent) => void } {
  return {
    relationalOrder: {
      key: "test-only-key",
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
  it("seals matching parent and child values without resting schema or row data", () => {
    const child = capture("order_lines", { order_id: 42, secret: "never-rest" })[0];
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
    expect(JSON.stringify(child)).not.toContain("42");
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
    expect(JSON.stringify(events[0])).not.toContain("42");
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
    const expected = [41, 42].map((id) => capture("order_lines", { order_id: id })[0]?.d);
    expect(events.map((event) => (event.d as Record<string, unknown>).valueIdentity)).toEqual(
      expected.map((data) => (data as Record<string, unknown>).valueIdentity),
    );
  });

  it("is deterministic, domain-separated, and changes when the key or declaration changes", () => {
    const first = capture("orders", { id: 42 })[0]?.d as Record<string, unknown>;
    const second = capture("orders", { id: 42 })[0]?.d as Record<string, unknown>;
    const changedKey = capture("orders", { id: 42 }, { key: "different-key" })[0]
      ?.d as Record<string, unknown>;
    const changedDeclaration = capture("orders", { id: 42 }, {
      declarations: [{ ...declaration, relationId: "different-relation" }],
    })[0]?.d as Record<string, unknown>;

    expect(first.relationIdentity).toBe(second.relationIdentity);
    expect(first.valueIdentity).toBe(second.valueIdentity);
    expect(first.relationIdentity).not.toBe(changedKey.relationIdentity);
    expect(first.valueIdentity).not.toBe(changedKey.valueIdentity);
    expect(first.relationIdentity).not.toBe(changedDeclaration.relationIdentity);
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
      { getOwnPropertyDescriptor() { throw new Error("hostile proxy"); } },
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
      statement: "INSERT INTO order_lines (order_id) VALUES ($1); DROP TABLE orders",
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
      capture("orders", { id: 42 }, {
        declarations: [{ ...declaration, constraintTiming: "deferred", deferrable: false }],
      }),
    ).toHaveLength(0);
  });

  it("enforces declaration and per-request event bounds", () => {
    const tooMany = Array.from({ length: MAX_RELATIONAL_ORDER_DECLARATIONS + 1 }, (_, index) => ({
      ...declaration,
      relationId: `r-${index}`,
    }));
    expect(capture("orders", { id: 42 }, { declarations: tooMany })).toHaveLength(0);

    const events: BugEvent[] = [];
    const input = options({ declarations: Array.from({ length: 32 }, (_, index) => ({
      ...declaration,
      relationId: `r-${index}`,
    })), maxEventsPerRequest: MAX_RELATIONAL_ORDER_EVENTS_PER_REQUEST + 10 }, events);
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
