import { createD1Database } from "@sqlbraid/sqlite/d1";
import { dialect, sql } from "@sqlbraid/sqlite";
import { createMigrator } from "@sqlbraid/migrate";

function manifest(body) {
  return { format: "sqlbraid-migrations", formatVersion: 1, dialects: { sqlite: {
    hash: "a".repeat(64), repeatable: [], versioned: [{ version: "1", description: "D1 migration",
      source: "V1__d1.sql", checksum: "b".repeat(64), sql: body }],
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
    const applied = (await migrator.startup(db, { mode: "apply" })).status;
    queries = 0;
    const verified = (await migrator.once(db, { mode: "verify", retryIntervalMs: 0 })).status;
    const verifyQueries = queries;
    queries = 0;
    const cached = (await migrator.once(db, { mode: "verify", retryIntervalMs: 0 })).status;
    const cachedQueries = queries;
    const rows = await db.all(sql.rows`SELECT value FROM audit ORDER BY rowid`);
    const failure = createMigrator({ dialect, table: "failed_history", manifest: manifest(
      "CREATE TABLE partial (value TEXT); INSERT INTO absent_table (value) VALUES ('failure');") });
    const failed = await code(() => failure.startup(db, { mode: "apply" }));
    const failedRows = await db.all(sql.rows`SELECT status FROM failed_history`);
    const partial = await db.all(sql.rows`SELECT value FROM partial`);
    const dirty = await code(() => failure.startup(db, { mode: "verify" }));
    // Both runners read empty history before either claims, so both compete for the same history rank.
    const { promise: bothRead, resolve: release } = Promise.withResolvers();
    let readers = 0;
    const synchronized = (database) => {
      let first = true;
      return { ...database, async all(query, options) {
        const rows = await database.all(query, options);
        if (first) {
          first = false;
          readers += 1;
          if (readers === 2) release();
          await bothRead;
        }
        return rows;
      } };
    };
    let runs = 0;
    const options = { dialect, table: "claim_history",
      manifest: manifest("CREATE TABLE claimed (value TEXT); INSERT INTO claimed (value) VALUES ('once');"),
      onEvent(event) { if (event.type === "migration.start") runs += 1; } };
    const [claimStatus, contender] = await Promise.all([
      createMigrator(options).startup(synchronized(db), { mode: "apply" }).then((report) => report.status),
      createMigrator(options).startup(synchronized(createD1Database(env.DB)), { mode: "apply" })
        .then((report) => report.status, (error) => error.code ?? String(error)),
    ]);
    return Response.json({ initial, applied, verified, verifyQueries, cached, cachedQueries, rows,
      failed, failedRows, partial, dirty, contender, claimStatus, runs });
  },
};
