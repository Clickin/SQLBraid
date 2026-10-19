// CPU profile of SQLBraid MySQL point queries. Run with: node --cpu-prof --cpu-prof-dir=<dir> tests/performance/mysql-profile.mjs <rows> <calls>
import { createConnection } from "mysql2/promise";
import { MYSQL2_NATIVE, sql } from "@sqlbraid/mysql";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";

const url = process.env.SQLBRAID_PERF_MYSQL_URL;
if (url === undefined) throw new Error("Set SQLBRAID_PERF_MYSQL_URL to the dedicated benchmark database.");
const n = Number(process.argv[2] ?? 1);
const calls = Number(process.argv[3] ?? 20000);
const conn = await createConnection({ uri: url, ...MYSQL2_NATIVE.connectionOptions });
await conn.query(
  "CREATE TABLE IF NOT EXISTS perf_t (id INT PRIMARY KEY, name VARCHAR(32), amount DOUBLE, big BIGINT, note TEXT, flag TINYINT, a VARCHAR(8), b VARCHAR(8), c INT, d DOUBLE)",
);
const [[{ c }]] = await conn.query("SELECT COUNT(*) AS c FROM perf_t");
if (Number(c) === 0) {
  const rows = [];
  for (let i = 1; i <= 10000; i += 1) rows.push([i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7]);
  for (let i = 0; i < rows.length; i += 1000)
    await conn.query("INSERT INTO perf_t VALUES ?", [rows.slice(i, i + 1000)]);
}
const db = createMysql2Database(conn);
for (let i = 0; i < calls; i += 1) await db.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`);
await conn.end();
