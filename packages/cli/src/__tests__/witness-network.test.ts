import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DataWitness } from "crumbtrail-core";
import { executeWitness } from "../witness/execute";

const postgres = process.env.WITNESS_TEST_POSTGRES_URL;
const mysql = process.env.WITNESS_TEST_MYSQL_URL;
const mongo = process.env.WITNESS_TEST_MONGODB_URL;
const mssql = process.env.WITNESS_TEST_MSSQL_URL;
const rowWitness = (
  engine: DataWitness["engine"],
  table: string,
): DataWitness => ({
  schemaVersion: "data-witness.v1",
  id: "network-test",
  engine,
  requiresBoundKey: true,
  confidence: "high",
  statements: [
    {
      table,
      identifyingColumns: ["id"],
      predicates: [
        { column: "id", value: 1 },
        { column: "total", value: 19 },
      ],
    },
  ],
});

for (const [engine, url] of [
  ["postgres", postgres],
  ["mysql", mysql],
  ["mssql", mssql],
] as const) {
  describe.skipIf(!url)(`${engine} witness adapter`, () => {
    it("observes repair and enforces the identifying row cap on the live engine", async () => {
      const table = `witness_${randomUUID().replaceAll("-", "")}`;
      let query: (sql: string) => Promise<unknown>;
      let close: () => Promise<void>;
      if (engine === "postgres") {
        const { Client } = await import("pg");
        const client = new Client({ connectionString: url });
        await client.connect();
        query = (sql) => client.query(sql);
        close = () => client.end();
      } else if (engine === "mysql") {
        const { createConnection } = await import("mysql2/promise");
        const client = await createConnection(url!);
        query = (sql) => client.query(sql);
        close = () => client.end();
      } else {
        const { ConnectionPool } = await import("mssql");
        const pool = await new ConnectionPool(url!).connect();
        query = (sql) => pool.request().query(sql);
        close = () => pool.close();
      }
      try {
        await query(
          `CREATE TABLE ${table} (id INTEGER PRIMARY KEY,total INTEGER,secret VARCHAR(100))`,
        );
        await query(
          `INSERT INTO ${table} VALUES ${Array.from({ length: 40 }, (_, i) => `(${i + 1},19,'private value')`).join(",")}`,
        );
        const witness = rowWitness(engine, table);
        expect((await executeWitness(witness, url!))[0]).toMatchObject({
          rowCount: 1,
          identifyingRows: [{ id: 1 }],
        });
        await query(`UPDATE ${table} SET total=20 WHERE id=1`);
        expect((await executeWitness(witness, url!))[0].rowCount).toBe(0);
        const all = {
          ...witness,
          requiresBoundKey: false,
          statements: [
            {
              ...witness.statements[0],
              predicates: [{ column: "total", value: 19 }],
            },
          ],
        };
        const [result] = await executeWitness(all, url!);
        expect(result.rowCount).toBe(39);
        expect(result.identifyingRows).toHaveLength(25);
        expect(JSON.stringify(result)).not.toContain("private value");
        const duplicate = {
          ...witness,
          statements: [
            {
              ...all.statements[0],
              keySets: [
                [{ column: "id", value: 2 }],
                [{ column: "id", value: 3 }],
              ],
              minimumRows: 1,
            },
          ],
        };
        expect((await executeWitness(duplicate, url!))[0].rowCount).toBe(2);
        await query(`DELETE FROM ${table} WHERE id=3`);
        expect((await executeWitness(duplicate, url!))[0].rowCount).toBe(0);
      } finally {
        await query(`DROP TABLE ${table}`).catch(() => {});
        await close();
      }
    }, 30_000);
  });
}
describe.skipIf(!mongo)("MongoDB witness adapter", () => {
  it("reads bounded documents and observes a repaired duplicate group", async () => {
    const { MongoClient } = await import("mongodb");
    const client = await new MongoClient(mongo!).connect();
    const table = `witness_${randomUUID().replaceAll("-", "")}`;
    const collection = client.db().collection(table);
    try {
      await collection.insertMany(
        Array.from({ length: 40 }, (_, i) => ({
          id: i + 1,
          total: 19,
          secret: "private value",
        })),
      );
      const witness = rowWitness("mongodb", table);
      expect((await executeWitness(witness, mongo!))[0]).toMatchObject({
        rowCount: 1,
        identifyingRows: [{ id: 1 }],
      });
      await collection.updateOne({ id: 1 }, { $set: { total: 20 } });
      expect((await executeWitness(witness, mongo!))[0].rowCount).toBe(0);
      const all = {
        ...witness,
        requiresBoundKey: false,
        statements: [
          {
            ...witness.statements[0],
            predicates: [{ column: "total", value: 19 }],
          },
        ],
      };
      const [result] = await executeWitness(all, mongo!);
      expect(result.rowCount).toBe(39);
      expect(result.identifyingRows).toHaveLength(25);
      const duplicate = {
        ...witness,
        statements: [
          {
            ...all.statements[0],
            keySets: [
              [{ column: "id", value: 2 }],
              [{ column: "id", value: 3 }],
            ],
            minimumRows: 1,
          },
        ],
      };
      expect((await executeWitness(duplicate, mongo!))[0].rowCount).toBe(2);
      await collection.deleteOne({ id: 3 });
      expect((await executeWitness(duplicate, mongo!))[0].rowCount).toBe(0);
    } finally {
      await collection.drop();
      await client.close();
    }
  });
});
