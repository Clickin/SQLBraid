import { createD1Database } from "@sqlbraid/sqlite/d1";
import { sql } from "@sqlbraid/sqlite";
import { verifyBulkConformance } from "../bulk-conformance.mjs";

export default {
  async fetch(_request, env) {
    let nativeBatchCalls = 0;
    const binding = {
      prepare(text) {
        return env.DB.prepare(text);
      },
      batch(statements) {
        nativeBatchCalls += 1;
        return env.DB.batch(statements);
      },
    };
    const events = [];
    const db = createD1Database(binding, { observers: [{ onEvent(event) { events.push(event); } }] });
    const conformanceReport = await verifyBulkConformance({
      db,
      sql,
      dialectId: "sqlite",
      expectedMode: "remote-batch",
      events,
      transactions: false,
    });
    const bulkOperationCount = events.filter((event) => event.type === "bulk:ready").length;
    if (nativeBatchCalls !== bulkOperationCount) {
      throw new Error(`D1 bulk conformance expected one native batch call per bulk operation (${bulkOperationCount}), received ${nativeBatchCalls}.`);
    }
    const bulkConformance = { ...conformanceReport, nativeBatchCalls, bulkOperationCount };
    const beforeUsersBulk = nativeBatchCalls;
    await db.execute(sql.command`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload BLOB)`);
    const inserted = await db.execute(sql.rows`INSERT INTO users (name, payload) VALUES (${"Ada"}, ${new Uint8Array([1, 2, 3])}) RETURNING id, name, payload`);
    const bulk = await db.bulk(["Grace", "Lin"], (name) => sql.command`INSERT INTO users (name) VALUES (${name})`);
    if (nativeBatchCalls !== beforeUsersBulk + 1) throw new Error("D1 users bulk did not use one native batch call.");
    const rows = await db.all(sql.rows`SELECT id, name, payload FROM users ORDER BY id`);
    const session = createD1Database(env.DB.withSession("first-primary"));
    await session.bulk(["Session"], (name) => sql.command`INSERT INTO users (name) VALUES (${name})`);
    const sessionRows = await session.all(sql.rows`SELECT name FROM users WHERE name = ${"Session"}`);
    let streamCode;
    try {
      for await (const _row of db.stream(sql.rows`SELECT id FROM users`)) void _row;
    } catch (error) {
      streamCode = error?.code;
    }
    let transactionCode;
    try {
      await db.tx(async () => undefined);
    } catch (error) {
      transactionCode = error?.code;
    }
    return Response.json({
      inserted: { kind: inserted.kind, rows: inserted.rows.map((row) => ({ ...row, payload: [...row.payload] })) },
      bulk,
      bulkConformance,
      sessionRows,
      rows: rows.map((row) => ({ ...row, payload: row.payload ? [...row.payload] : null })),
      streamCode,
      transactionCode,
    });
  },
};
