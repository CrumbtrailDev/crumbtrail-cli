import { describe, expect, it, vi } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  AUTO_INSTRUMENT_DRIVERS,
  autoInstrumentDbClients,
  instrumentMongoClient,
  MONGO_IMAGE_UNAVAILABLE,
} from "../db";

type Listener = (event: unknown) => void;

class FakeMongoClient {
  readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  succeed(
    requestId: number,
    commandName: string,
    command: Record<string, unknown>,
    reply: Record<string, unknown>,
  ): void {
    this.fire("commandStarted", { requestId, commandName, command });
    this.fire("commandSucceeded", { requestId, commandName, reply });
  }

  fail(
    requestId: number,
    commandName: string,
    command: Record<string, unknown>,
    failure: unknown,
  ): void {
    this.fire("commandStarted", { requestId, commandName, command });
    this.fire("commandFailed", { requestId, commandName, failure });
  }

  private fire(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function capture(options: Record<string, unknown> = {}) {
  const events: BugEvent[] = [];
  const client = instrumentMongoClient(new FakeMongoClient(), {
    requestId: "req-mongo",
    emit: (event) => events.push(event),
    ...options,
  });
  return { client, events };
}

function eventsOf(events: BugEvent[], kind: string): BugEvent[] {
  return events.filter((event) => event.k === kind);
}

describe("instrumentMongoClient", () => {
  it("maps insertMany to capped db.diff rows with _id primary keys, redaction, and document bounds", () => {
    const { client, events } = capture({ maxRowsPerStatement: 1 });
    const wide = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [`field${index}`, index]),
    );
    const deep = { level: {} as Record<string, unknown> };
    let cursor = deep.level;
    for (let depth = 0; depth < 12; depth += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    client.succeed(
      1,
      "insert",
      {
        insert: "accounts",
        documents: [
          {
            _id: "acct-1",
            password: "must-not-rest",
            profile: { apiToken: "token-must-not-rest", wide, deep },
          },
          { _id: "acct-2", status: "ready" },
        ],
      },
      { ok: 1, n: 2 },
    );

    const diffs = eventsOf(events, "db.diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.d).toMatchObject({
      engine: "mongodb",
      op: "insert",
      table: "accounts",
      pk: { _id: "acct-1" },
    });
    const serialized = JSON.stringify(diffs[0]);
    expect(serialized).not.toContain("must-not-rest");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("maximum document depth");
    expect(serialized).toContain("container size limit");

    expect(eventsOf(events, "db.diff.bulk")[0]?.d).toEqual({
      engine: "mongodb",
      op: "insert",
      table: "accounts",
      requestId: "req-mongo",
      rowCount: 2,
      emittedRows: 1,
      truncatedRows: 1,
      samplePks: [{ _id: "acct-1" }, { _id: "acct-2" }],
    });
  });

  it("maps updateOne without inventing row images and retains an exact _id", () => {
    const { client, events } = capture();
    client.succeed(
      2,
      "update",
      {
        update: "accounts",
        updates: [{ q: { _id: "acct-1" }, u: { $set: { status: "ready" } } }],
      },
      { ok: 1, n: 1, nModified: 1 },
    );

    const diff = eventsOf(events, "db.diff")[0];
    expect(diff?.d).toMatchObject({
      engine: "mongodb",
      op: "update",
      table: "accounts",
      pk: { _id: "acct-1" },
      rowCount: 1,
      imageUnavailable: {
        before: MONGO_IMAGE_UNAVAILABLE.updateBefore,
        after: MONGO_IMAGE_UNAVAILABLE.updateAfter,
      },
    });
    expect(diff?.d).not.toHaveProperty("before");
    expect(diff?.d).not.toHaveProperty("after");
  });

  it("suppresses race evidence when command monitoring cannot prove transaction outcome", () => {
    const { client, events } = capture({
      raceEvidence: {
        enabled: true,
        resolve: () => ({ entityHash: "e".repeat(64) }),
      },
    });
    client.succeed(
      21,
      "update",
      {
        update: "accounts",
        updates: [{ q: { _id: "acct-1" }, u: { $set: { status: "ready" } } }],
      },
      { ok: 1, n: 1 },
    );
    client.succeed(
      22,
      "delete",
      { delete: "accounts", deletes: [{ q: { _id: "acct-2" }, limit: 1 }] },
      { ok: 1, n: 1 },
    );
    client.succeed(
      23,
      "findAndModify",
      {
        findAndModify: "accounts",
        query: { _id: "acct-3" },
        update: { $set: { status: "ready" } },
        new: true,
      },
      {
        ok: 1,
        lastErrorObject: { n: 1 },
        value: { _id: "acct-3", status: "ready" },
      },
    );

    expect(eventsOf(events, "db.diff")).toHaveLength(3);
    expect(
      eventsOf(events, "db.diff").every(
        (event) => event.d.raceEvidence === undefined,
      ),
    ).toBe(true);
  });

  it("keeps successful and failed transaction work free of race evidence", () => {
    const { client, events } = capture({
      raceEvidence: {
        enabled: true,
        resolve: () => ({ entityHash: "e".repeat(64) }),
      },
    });
    client.succeed(
      24,
      "update",
      {
        update: "accounts",
        updates: [{ q: { _id: "acct-commit" }, u: { $set: { ok: true } } }],
      },
      { ok: 1, n: 1 },
    );
    client.fail(
      25,
      "update",
      {
        update: "accounts",
        updates: [{ q: { _id: "acct-rollback" }, u: { $set: { ok: true } } }],
      },
      { name: "MongoServerError", code: 112 },
    );

    expect(eventsOf(events, "db.diff")).toHaveLength(1);
    expect(eventsOf(events, "db.diff")[0]?.d.raceEvidence).toBeUndefined();
  });

  it("maps bulk update and delete commands to aggregate partial diffs", () => {
    const { client, events } = capture();
    client.succeed(
      3,
      "update",
      {
        update: "accounts",
        updates: [
          {
            q: { status: "new" },
            u: { $set: { status: "ready" } },
            multi: true,
          },
          { q: { _id: "acct-9" }, u: { $inc: { attempts: 1 } } },
        ],
      },
      { ok: 1, n: 4, nModified: 4 },
    );
    client.succeed(
      4,
      "delete",
      {
        delete: "accounts",
        deletes: [
          { q: { expired: true }, limit: 0 },
          { q: { _id: "acct-9" }, limit: 1 },
        ],
      },
      { ok: 1, n: 3 },
    );

    const [update, deletion] = eventsOf(events, "db.diff");
    expect(update?.d).toMatchObject({
      op: "update",
      pk: null,
      rowCount: 4,
      imageUnavailable: {
        before: MONGO_IMAGE_UNAVAILABLE.updateBefore,
        after: MONGO_IMAGE_UNAVAILABLE.updateAfter,
      },
    });
    expect(deletion?.d).toMatchObject({
      op: "delete",
      pk: null,
      rowCount: 3,
      imageUnavailable: {
        before: MONGO_IMAGE_UNAVAILABLE.deleteBefore,
      },
    });
  });

  it("records a genuine findOneAndUpdate pre-image and states that the after-image is unavailable", () => {
    const { client, events } = capture();
    client.succeed(
      5,
      "findAndModify",
      {
        findAndModify: "accounts",
        query: { _id: "acct-1" },
        update: { $set: { status: "ready" } },
        new: false,
      },
      {
        ok: 1,
        lastErrorObject: { n: 1, updatedExisting: true },
        value: { _id: "acct-1", status: "new" },
      },
    );

    expect(eventsOf(events, "db.diff")[0]?.d).toMatchObject({
      op: "update",
      pk: { _id: "acct-1" },
      before: { _id: "acct-1", status: "new" },
      imageUnavailable: {
        after: MONGO_IMAGE_UNAVAILABLE.returnedBefore,
      },
    });
  });

  it("records a genuine findOneAndUpdate post-image and states that the pre-image is unavailable", () => {
    const { client, events } = capture();
    client.succeed(
      6,
      "findAndModify",
      {
        findAndModify: "accounts",
        query: { _id: "acct-1" },
        update: { $set: { status: "ready" } },
        new: true,
      },
      {
        ok: 1,
        lastErrorObject: { n: 1, updatedExisting: true },
        value: { _id: "acct-1", status: "ready" },
      },
    );

    expect(eventsOf(events, "db.diff")[0]?.d).toMatchObject({
      op: "update",
      after: { _id: "acct-1", status: "ready" },
      imageUnavailable: {
        before: MONGO_IMAGE_UNAVAILABLE.returnedAfter,
      },
    });
  });

  it("marks a projected findAndModify result as a partial image", () => {
    const { client, events } = capture();
    client.succeed(
      61,
      "findAndModify",
      {
        findAndModify: "accounts",
        query: { _id: "acct-1" },
        update: { $set: { status: "ready" } },
        fields: { status: 1 },
        new: false,
      },
      {
        ok: 1,
        lastErrorObject: { n: 1, updatedExisting: true },
        value: { _id: "acct-1", status: "new" },
      },
    );

    expect(eventsOf(events, "db.diff")[0]?.d).toMatchObject({
      before: { _id: "acct-1", status: "new" },
      imageUnavailable: {
        before: MONGO_IMAGE_UNAVAILABLE.projectedBefore,
        after: MONGO_IMAGE_UNAVAILABLE.returnedBefore,
      },
    });
  });

  it("maps findOneAndDelete to a before-only delete diff", () => {
    const { client, events } = capture();
    client.succeed(
      7,
      "findAndModify",
      { findAndModify: "accounts", query: { _id: "acct-1" }, remove: true },
      {
        ok: 1,
        lastErrorObject: { n: 1 },
        value: { _id: "acct-1", status: "expired" },
      },
    );

    const diff = eventsOf(events, "db.diff")[0];
    expect(diff?.d).toMatchObject({
      op: "delete",
      pk: { _id: "acct-1" },
      before: { _id: "acct-1", status: "expired" },
    });
    expect(diff?.d).not.toHaveProperty("after");
    expect(diff?.d).not.toHaveProperty("imageUnavailable");
  });

  it("maps find and getMore batches onto capped, redacted db.read events", () => {
    const { client, events } = capture({
      captureReads: true,
      maxReadRowsPerStatement: 1,
    });
    client.succeed(
      8,
      "find",
      { find: "accounts", filter: { status: "ready" } },
      {
        ok: 1,
        cursor: {
          firstBatch: [
            { _id: "acct-1", password: "first-secret" },
            { _id: "acct-2", password: "second-secret" },
          ],
        },
      },
    );
    client.succeed(
      9,
      "getMore",
      { getMore: 42, collection: "accounts" },
      { ok: 1, cursor: { nextBatch: [{ _id: "acct-3", status: "ready" }] } },
    );

    const reads = eventsOf(events, "db.read");
    expect(reads).toHaveLength(2);
    expect(reads.map((event) => event.d.pk)).toEqual([
      { _id: "acct-1" },
      { _id: "acct-3" },
    ]);
    expect(JSON.stringify(reads)).not.toContain("first-secret");
    expect(eventsOf(events, "db.read.bulk")[0]?.d).toMatchObject({
      engine: "mongodb",
      table: "accounts",
      rowCount: 2,
      emittedRows: 1,
      truncatedRows: 1,
    });
  });

  it("emits db.error for a failed command and contains a throwing sink", () => {
    const { client, events } = capture();
    client.fail(
      10,
      "update",
      { update: "accounts", updates: [] },
      { name: "MongoServerError", code: 11000 },
    );
    expect(eventsOf(events, "db.error")[0]?.d).toMatchObject({
      engine: "mongodb",
      op: "update",
      table: "accounts",
      code: "11000",
    });

    const hostile = instrumentMongoClient(new FakeMongoClient(), {
      requestId: "req-hostile",
      emit: () => {
        throw new Error("sink failed");
      },
    });
    expect(() =>
      hostile.succeed(
        11,
        "insert",
        { insert: "accounts", documents: [{ _id: "acct-1" }] },
        { ok: 1, n: 1 },
      ),
    ).not.toThrow();
  });
});

describe("MongoDB auto-instrumentation", () => {
  it("constructs MongoClient with monitorCommands enabled and attaches capture", () => {
    let constructedOptions: Record<string, unknown> | undefined;
    class MongoClient extends FakeMongoClient {
      constructor(_url: string, options?: Record<string, unknown>) {
        super();
        constructedOptions = options;
      }
    }
    const mod = { MongoClient } as Record<string, unknown>;
    const suppliedOptions = { monitorCommands: false, maxPoolSize: 5 };
    const emit = vi.fn<(event: BugEvent) => void>();

    const report = autoInstrumentDbClients({
      drivers: ["mongodb"],
      resolve: () => mod,
      requestId: "req-auto",
      emit,
    });

    const Patched = mod.MongoClient as new (
      url: string,
      options?: Record<string, unknown>,
    ) => FakeMongoClient;
    const client = new Patched("mongodb://localhost/test", suppliedOptions);
    expect(constructedOptions).toEqual({
      monitorCommands: true,
      maxPoolSize: 5,
    });
    expect(suppliedOptions).toEqual({ monitorCommands: false, maxPoolSize: 5 });
    expect(report.results).toEqual([{ driver: "mongodb", status: "patched" }]);

    client.succeed(
      12,
      "insert",
      { insert: "accounts", documents: [{ _id: "acct-auto" }] },
      { ok: 1, n: 1 },
    );
    expect(emit.mock.calls.some(([event]) => event.k === "db.diff")).toBe(true);
  });

  it("lists mongodb as a supported automatic driver", () => {
    expect(AUTO_INSTRUMENT_DRIVERS).toContain("mongodb");
  });
});
