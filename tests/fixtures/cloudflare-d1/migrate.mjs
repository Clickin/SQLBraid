import { createD1Database } from "@sqlbraid/sqlite/d1";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createMigrator } from "@sqlbraid/migrate";

function manifest(body) {
  return { format: "sqlbraid-migrations", formatVersion: 1, dialects: { sqlite: {
    hash: "a".repeat(64), repeatable: [], versioned: [{ version: "1", description: "D1 migration",
      source: "V1__d1.sql", checksum: "b".repeat(64), load: async () => body }],
  } } };
}
async function code(fn) {
  try { await fn(); return "no-error"; } catch (error) { return error.code ?? String(error); }
}
export default {
  async fetch(_request, env) {
    let queries = 0;
    const db = createD1Database(env.DB, { observers: [{ onEvent(event) {
      if (event.type === "query:ready") queries += 1;
    } }] });
    const migrator = createMigrator({ dialect, manifest: manifest(`CREATE TABLE data (value TEXT);
CREATE TABLE audit (value TEXT);
CREATE TRIGGER record_value AFTER INSERT ON data BEGIN
 INSERT INTO audit (value) VALUES (NEW.value);
 INSERT INTO audit (value) VALUES ('semi;colon');
END;
INSERT INTO data (value) VALUES ('applied');`) });
    const initial = await code(() => migrator.once(db, { mode: "verify", retryIntervalMs: 0 }));
    const applied = (await migrator.up(db)).status;
    queries = 0;
    const verified = (await migrator.once(db, { mode: "verify", retryIntervalMs: 0 })).status;
    const verifyQueries = queries;
    queries = 0;
    const cached = (await migrator.once(db, { mode: "verify", retryIntervalMs: 0 })).status;
    const cachedQueries = queries;
    const rows = await db.all(sql.rows`SELECT value FROM audit ORDER BY rowid`);
    const failure = createMigrator({ dialect, table: "failed_history", manifest: manifest(
      "CREATE TABLE partial (value TEXT); INSERT INTO absent_table (value) VALUES ('failure');") });
    const failed = await code(() => failure.up(db));
    const failedRows = await db.all(sql.rows`SELECT status FROM failed_history`);
    const partial = await db.all(sql.rows`SELECT value FROM partial`);
    const dirty = await code(() => failure.startup(db, { mode: "verify" }));
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const { promise: started, resolve: entered } = Promise.withResolvers();
    let runs = 0;
    const options = { dialect, table: "claim_history", manifest: manifest(async () => {
      runs += 1; entered(); await gate;
    }) };
    const applying = createMigrator(options).up(db);
    let contender;
    let claimStatus;
    try {
      await Promise.race([started, applying.then(() => { throw new Error("Migration body did not run"); })]);
      contender = await code(() => createMigrator(options).up(createD1Database(env.DB)));
    } finally {
      release();
      claimStatus = (await applying).status;
    }
    return Response.json({ initial, applied, verified, verifyQueries, cached, cachedQueries, rows,
      failed, failedRows, partial, dirty, contender, claimStatus, runs });
  },
};
