// Usage: node --cpu-prof --cpu-prof-dir=<dir> tests/performance/sqlite-profile.mjs <better|node> <rows> <iterations>
import { DatabaseSync } from "node:sqlite";
import Better from "better-sqlite3";
import { sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";

const [driver, rowsArg, iterationsArg] = process.argv.slice(2);
const n = Number(rowsArg);
const raw = driver === "better" ? new Better(":memory:") : new DatabaseSync(":memory:");
raw.exec(
  `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, note TEXT, flag INTEGER, a TEXT, b TEXT, c INTEGER, d REAL);`,
);
const insert = raw.prepare("INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)");
for (let i = 1; i <= 10000; i += 1) insert.run(i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7);
const db = driver === "better" ? createBetterSqlite3Database(raw) : createNodeSqliteDatabase(raw);
for (let i = 0; i < 300; i += 1) await db.all(sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`);
for (let i = 0; i < Number(iterationsArg); i += 1) await db.all(sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`);
