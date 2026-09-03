import { compileDataWitness, DATA_WITNESS_ROW_CAP, type DataWitness, type CompiledWitnessStatement, type WitnessStatementObservation } from "crumbtrail-core";

export interface WitnessConnection {
  execute(statement: CompiledWitnessStatement): Promise<{ rowCount: number; identifyingRows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}
export class WitnessConnectionError extends Error {
  constructor(readonly target: string) { super("WITNESS_CONNECTION_FAILED"); }
}
export async function executeWitness(witness: DataWitness, connectionString: string, connect = connectWitness): Promise<WitnessStatementObservation[]> {
  const statements = compileDataWitness(witness);
  let connection: WitnessConnection | undefined;
  try {
    connection = await connect(witness.engine, connectionString);
    const result: WitnessStatementObservation[] = [];
    for (const statement of statements) {
      const rows = await connection.execute(statement);
      if (!Number.isSafeInteger(rows.rowCount) || rows.rowCount < 0) throw new Error("WITNESS_COUNT_INVALID");
      result.push({ shape: statement.shape, parameters: statement.parameters, status: "executed", rowCount: rows.rowCount, identifyingRows: rows.identifyingRows.slice(0, DATA_WITNESS_ROW_CAP).map((row) => Object.fromEntries(statement.identifyingColumns.map((column) => [column, row[column]]))) });
    }
    return result;
  } catch {
    let target = "database";
    try { target = witness.engine === "sqlite" ? connectionString : new URL(connectionString).hostname; } catch { /* Driver errors can contain credentials and SQL. */ }
    throw new WitnessConnectionError(target);
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}

export async function connectWitness(engine: DataWitness["engine"], url: string): Promise<WitnessConnection> {
  if (engine === "postgres") {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try { await client.connect(); await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL statement_timeout = '10000ms'"); }
    catch (error) { await client.end().catch(() => {}); throw error; }
    return { async execute(s) {
      const result = await client.query(`SELECT *, COUNT(*) OVER() AS "__witness_count" FROM (${s.shape}) AS witness_rows LIMIT 25`, s.parameters);
      return { rowCount: Number(result.rows[0]?.__witness_count ?? 0), identifyingRows: result.rows };
    }, async close() { try { await client.query("ROLLBACK"); } finally { await client.end(); } } };
  }
  if (engine === "mysql") {
    const { createConnection } = await import("mysql2/promise");
    const client = await createConnection({ uri: url, connectTimeout: 5000, multipleStatements: false });
    try { await client.query("SET TRANSACTION READ ONLY"); await client.query("START TRANSACTION"); }
    catch (error) { await client.end().catch(() => {}); throw error; }
    return { async execute(s) {
      const [rows] = await client.execute(`SELECT *, COUNT(*) OVER() AS __witness_count FROM (${s.shape}) AS witness_rows LIMIT 25`, s.parameters);
      const result = rows as Record<string, unknown>[];
      return { rowCount: Number(result[0]?.__witness_count ?? 0), identifyingRows: result };
    }, async close() { try { await client.rollback(); } finally { await client.end(); } } };
  }
  if (engine === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(url, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return { async execute(s) {
      const rows = db.prepare(`SELECT *, COUNT(*) OVER() AS __witness_count FROM (${s.shape}) AS witness_rows LIMIT 25`).all(...s.parameters.map((v) => typeof v === "boolean" ? Number(v) : v));
      return { rowCount: Number(rows[0]?.__witness_count ?? 0), identifyingRows: rows };
    }, async close() { db.close(); } };
  }
  if (engine === "mongodb") {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000, retryReads: false, retryWrites: false });
    try { await client.connect(); } catch (error) { await client.close().catch(() => {}); throw error; }
    return { async execute(s) {
      const projection = Object.fromEntries(s.identifyingColumns.map((key) => [key, 1]));
      if (!s.identifyingColumns.includes("_id")) projection._id = 0;
      const [result] = await client.db().collection(s.table).aggregate([{ $match: s.filter }, { $facet: { count: [{ $count: "total" }], rows: [{ $limit: 25 }, { $project: projection }] } }], { maxTimeMS: 10000 }).toArray();
      return { rowCount: Number(result?.count?.[0]?.total ?? 0), identifyingRows: result?.rows ?? [] };
    }, async close() { await client.close(); } };
  }
  const { ConnectionPool, Transaction, Request, ISOLATION_LEVEL } = await import("mssql");
  const pool = new ConnectionPool(url);
  try { await pool.connect(); } catch (error) { await pool.close().catch(() => {}); throw error; }
  const transaction = new Transaction(pool);
  try { await transaction.begin(ISOLATION_LEVEL.SERIALIZABLE); } catch (error) { await pool.close(); throw error; }
  return { async execute(s) {
    const request = new Request(transaction);
    s.parameters.forEach((value, i) => request.input(`p${i}`, value));
    const result = await request.query(`SELECT TOP (25) *, COUNT_BIG(*) OVER() AS __witness_count FROM (${s.shape}) AS witness_rows`);
    return { rowCount: Number(result.recordset[0]?.__witness_count ?? 0), identifyingRows: result.recordset };
  }, async close() { try { await transaction.rollback(); } finally { await pool.close(); } } };
}
