// Alternates a baseline build (tests/performance/.builds/mysql-baseline/mysql) and the current build against the MySQL benchmark database.
import { createConnection } from "mysql2/promise";
import * as next from "@sqlbraid/mysql";
import * as nextAdapter from "@sqlbraid/mysql/mysql2";
import * as baseAdapter from "./.builds/mysql-baseline/mysql/mysql2.js";
import * as baseRoot from "./.builds/mysql-baseline/mysql/index.js";
const options = { uri: process.env.SQLBRAID_PERF_MYSQL_URL, ...next.MYSQL2_NATIVE.connectionOptions };
const c1 = await createConnection(options),
  c2 = await createConnection(options);
const baseDb = baseAdapter.createMysql2Database(c1),
  nextDb = nextAdapter.createMysql2Database(c2);
const mk = (db, sql, n) => () => db.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`);
const median = (a) => a.toSorted((x, y) => x - y)[a.length >> 1];
for (const [shape, n, budget] of [
  ["point-1", 1, 500],
  ["rows-100", 100, 500],
  ["rows-10000", 10000, 1500],
]) {
  const v = { base: mk(baseDb, baseRoot.sql, n), next: mk(nextDb, next.sql, n) };
  const per = { base: [], next: [] };
  for (let r = 0; r < 9; r++)
    for (const k of r % 2 ? ["next", "base"] : ["base", "next"]) {
      for (let i = 0; i < 20; i++) await v[k]();
      const t0 = performance.now();
      let calls = 0;
      while (performance.now() - t0 < budget) {
        await v[k]();
        calls++;
      }
      per[k].push(((performance.now() - t0) * 1000) / calls);
    }
  const d = per.base.map((x, i) => x - per.next[i]);
  console.log(
    shape.padEnd(11),
    "base",
    median(per.base).toFixed(1),
    "us  next",
    median(per.next).toFixed(1),
    "us  paired base-next",
    median(d).toFixed(1),
    "us  next faster",
    d.filter((x) => x > 0).length,
    "/ 9",
  );
}
await c1.end();
await c2.end();
