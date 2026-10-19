// Alternates a baseline build (tests/performance/.builds/oracle-baseline/oracle) and the current build against the Oracle benchmark database.
// Usage: SQLBRAID_PERF_ORACLE_URL=127.0.0.1:51521/FREEPDB1 SQLBRAID_PERF_ORACLE_PASSWORD=... node tests/performance/oracle-compare-builds.mjs
import oracledb from "oracledb";
import * as next from "@sqlbraid/oracle";
import * as nextAdapter from "@sqlbraid/oracle/oracledb";
import * as baseAdapter from "./.builds/oracle-baseline/oracle/oracledb.js";
import * as baseRoot from "./.builds/oracle-baseline/oracle/index.js";

const connectString = process.env.SQLBRAID_PERF_ORACLE_URL;
const password = process.env.SQLBRAID_PERF_ORACLE_PASSWORD;
if (connectString === undefined || password === undefined) {
  throw new Error(
    "Set SQLBRAID_PERF_ORACLE_URL and SQLBRAID_PERF_ORACLE_PASSWORD for the dedicated benchmark database.",
  );
}
const credentials = { user: "perf", password, connectString };
const seed = await oracledb.getConnection(credentials);
await seed.execute(
  `BEGIN EXECUTE IMMEDIATE 'DROP TABLE perf_t'; EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;`,
);
await seed.execute(
  "CREATE TABLE perf_t (id NUMBER(10) PRIMARY KEY, name VARCHAR2(32), amount BINARY_DOUBLE, big NUMBER(19), note VARCHAR2(64), flag NUMBER(1), a VARCHAR2(8), b VARCHAR2(8), c NUMBER(10), d BINARY_DOUBLE)",
);
const binds = [];
for (let i = 1; i <= 10000; i += 1) binds.push([i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7]);
await seed.executeMany("INSERT INTO perf_t VALUES (:1,:2,:3,:4,:5,:6,:7,:8,:9,:10)", binds, { autoCommit: true });
await seed.close();

const c1 = await oracledb.getConnection(credentials);
const c2 = await oracledb.getConnection(credentials);
const baseDb = baseAdapter.createOracledbDatabase(c1);
const nextDb = nextAdapter.createOracledbDatabase(c2);
const make = (db, sql, n) => () => db.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`);
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
try {
  for (const [shape, n, budget] of [
    ["point-1", 1, 500],
    ["rows-100", 100, 500],
    ["rows-10000", 10000, 2000],
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
  await c1.close();
  await c2.close();
}
