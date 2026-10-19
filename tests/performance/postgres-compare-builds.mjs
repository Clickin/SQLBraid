// Alternates a baseline build (tests/performance/.builds/postgres-baseline/postgres) and the current build against the PostgreSQL benchmark database.
import pg from "pg";
import * as next from "@sqlbraid/postgres";
import * as nextAdapter from "@sqlbraid/postgres/pg";
import * as baseAdapter from "./.builds/postgres-baseline/postgres/pg.js";
import * as baseRoot from "./.builds/postgres-baseline/postgres/index.js";

const url = process.env.SQLBRAID_PERF_URL;
if (url === undefined) throw new Error("Set SQLBRAID_PERF_URL to the dedicated benchmark database.");
const c1 = new pg.Client({ connectionString: url });
const c2 = new pg.Client({ connectionString: url });
await c1.connect();
await c2.connect();
const baseDb = baseAdapter.createPgDatabase(c1);
const nextDb = nextAdapter.createPgDatabase(c2);
const make = (db, sql, n) => () =>
  db.all(
    sql.rows`SELECT i::int4 AS id, 'n' || i AS name, (i / 3.0)::float8 AS amount, (i * 1000)::int8 AS big, 'note ' || i AS note, (i % 2)::int2 AS flag, 'a' AS a, 'b' AS b, i::int4 AS c, (i / 7.0)::float8 AS d FROM generate_series(1, ${n}::int) AS i`,
  );
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
