// Alternates a baseline build (tests/performance/.builds/mssql-baseline/mssql) and the current build against the SQL Server benchmark database.
// Usage: SQLBRAID_PERF_MSSQL_PORT=51433 SQLBRAID_PERF_MSSQL_PASSWORD=... node tests/performance/mssql-compare-builds.mjs
import { Connection, Request } from "tedious";
import * as next from "@sqlbraid/mssql";
import * as nextAdapter from "@sqlbraid/mssql/tedious";
import * as baseAdapter from "./.builds/mssql-baseline/mssql/tedious.js";
import * as baseRoot from "./.builds/mssql-baseline/mssql/index.js";

const port = Number(process.env.SQLBRAID_PERF_MSSQL_PORT);
const password = process.env.SQLBRAID_PERF_MSSQL_PASSWORD;
if (!Number.isInteger(port) || password === undefined) {
  throw new Error(
    "Set SQLBRAID_PERF_MSSQL_PORT and SQLBRAID_PERF_MSSQL_PASSWORD for the dedicated benchmark database.",
  );
}
const connect = () => {
  const connection = new Connection({
    server: "127.0.0.1",
    options: {
      port,
      database: "master",
      encrypt: false,
      trustServerCertificate: true,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
    },
    authentication: { type: "default", options: { userName: "sa", password } },
  });
  return new Promise((resolve, reject) => {
    connection.once("connect", (error) => (error ? reject(error) : resolve(connection)));
    connection.connect();
  });
};
const run = (connection, text) =>
  new Promise((resolve, reject) => {
    const request = new Request(text, (error) => (error ? reject(error) : resolve()));
    connection.execSql(request);
  });

const seed = await connect();
await run(seed, "DROP TABLE IF EXISTS perf_t");
await run(
  seed,
  "CREATE TABLE perf_t (id INT PRIMARY KEY, name NVARCHAR(32), amount FLOAT, big BIGINT, note NVARCHAR(64), flag TINYINT, a NVARCHAR(8), b NVARCHAR(8), c INT, d FLOAT)",
);
for (let start = 1; start <= 10000; start += 500) {
  const values = [];
  for (let i = start; i < start + 500; i += 1)
    values.push(`(${i},'n${i}',${i / 3},${i * 1000},'note ${i}',${i % 2},'a','b',${i},${i / 7})`);
  await run(seed, `INSERT INTO perf_t VALUES ${values.join(",")}`);
}
seed.close();

const c1 = await connect();
const c2 = await connect();
const baseDb = baseAdapter.createTediousDatabase(c1);
const nextDb = nextAdapter.createTediousDatabase(c2);
const make = (db, sql, n) => () => db.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`);
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
try {
  for (const [shape, n, budget] of [
    ["point-1", 1, 500],
    ["rows-100", 100, 500],
    ["rows-10000", 10000, 2500],
  ]) {
    const v = { base: make(baseDb, baseRoot.sql, n), next: make(nextDb, next.sql, n) };
    const per = { base: [], next: [] };
    for (let round = 0; round < 9; round += 1) {
      for (const name of round % 2 ? ["next", "base"] : ["base", "next"]) {
        for (let i = 0; i < 10; i += 1) await v[name]();
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
  c1.close();
  c2.close();
}
