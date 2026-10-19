// Alternates a baseline build (tests/performance/.builds/mariadb-baseline/mariadb) and the current build against the MariaDB benchmark database.
// Usage: SQLBRAID_PERF_MARIADB_PORT=53307 SQLBRAID_PERF_MARIADB_PASSWORD=... node tests/performance/mariadb-compare-builds.mjs
import mariadb from "mariadb";
import * as next from "@sqlbraid/mariadb";
import * as nextAdapter from "@sqlbraid/mariadb/mariadb";
import * as baseAdapter from "./.builds/mariadb-baseline/mariadb/mariadb.js";
import * as baseRoot from "./.builds/mariadb-baseline/mariadb/index.js";

const port = Number(process.env.SQLBRAID_PERF_MARIADB_PORT);
const password = process.env.SQLBRAID_PERF_MARIADB_PASSWORD;
if (!Number.isInteger(port) || password === undefined) {
  throw new Error(
    "Set SQLBRAID_PERF_MARIADB_PORT and SQLBRAID_PERF_MARIADB_PASSWORD for the dedicated benchmark database.",
  );
}
const options = {
  ...next.MARIADB_LOSSLESS_TEXT.connectionOptions,
  host: "127.0.0.1",
  port,
  user: "root",
  password,
  database: "sqlbraid_perf",
};
const seed = await mariadb.createConnection(options);
await seed.query("DROP TABLE IF EXISTS perf_t");
await seed.query(
  "CREATE TABLE perf_t (id INT PRIMARY KEY, name VARCHAR(32), amount DOUBLE, big BIGINT, note TEXT, flag TINYINT, a VARCHAR(8), b VARCHAR(8), c INT, d DOUBLE)",
);
const inserts = [];
for (let i = 1; i <= 10000; i += 1) inserts.push([i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7]);
for (let i = 0; i < inserts.length; i += 1000)
  await seed.batch("INSERT INTO perf_t VALUES (?,?,?,?,?,?,?,?,?,?)", inserts.slice(i, i + 1000));
await seed.end();

const c1 = await mariadb.createConnection(options);
const c2 = await mariadb.createConnection(options);
const baseDb = baseAdapter.createMariaDbDatabase(c1);
const nextDb = nextAdapter.createMariaDbDatabase(c2);
const make = (db, sql, n) => () => db.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`);
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
try {
  for (const [shape, n, budget] of [
    ["point-1", 1, 500],
    ["rows-100", 100, 500],
    ["rows-10000", 10000, 1500],
  ]) {
    const v = { base: make(baseDb, baseRoot.sql, n), next: make(nextDb, next.sql, n) };
    const per = { base: [], next: [] };
    for (let round = 0; round < 9; round += 1) {
      for (const name of round % 2 ? ["next", "base"] : ["base", "next"]) {
        for (let i = 0; i < 20; i += 1) await v[name]();
        const t0 = performance.now();
        let calls = 0;
        while (performance.now() - t0 < budget) {
          await v[name]();
          calls += 1;
        }
        per[name].push(((performance.now() - t0) * 1000) / calls);
      }
    }
    const d = per.base.map((value, index) => value - per.next[index]);
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
} finally {
  await c1.end();
  await c2.end();
}
