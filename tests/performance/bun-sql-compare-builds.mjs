// Alternates a baseline build (tests/performance/.builds/bun-sql-baseline/bun-sql) and the current build on Bun.SQL SQLite in memory.
// Run with Bun: bun tests/performance/bun-sql-compare-builds.mjs [sqlite|postgres]
// postgres needs SQLBRAID_PERF_URL for the dedicated benchmark database.
import * as nextAdapter from "@sqlbraid/bun-sql";
import * as baseAdapter from "./.builds/bun-sql-baseline/bun-sql/index.js";
const target = process.argv[2] ?? "sqlite";
const { sql } = target === "postgres" ? await import("@sqlbraid/postgres") : await import("@sqlbraid/sqlite");

const open = async (adapter) => {
  if (target === "postgres") {
    const url = process.env.SQLBRAID_PERF_URL;
    if (url === undefined) throw new Error("Set SQLBRAID_PERF_URL to the dedicated benchmark database.");
    const client = new Bun.SQL(url, { bigint: true });
    await client.unsafe("DROP TABLE IF EXISTS perf_bun");
    await client.unsafe(
      "CREATE TABLE perf_bun AS SELECT i::int8 AS id, 'n' || i AS name, (i / 3.0 + 0.5)::float8 AS amount, (i * 1000)::int8 AS big, 'note ' || i AS note, (i % 2)::int8 AS flag, 'a' AS a, 'b' AS b, i::int8 AS c, (i / 7.0 + 0.5)::float8 AS d FROM generate_series(1, 10000) AS i",
    );
    return { client, db: adapter.createBunSqlDatabase(client, { dialect: "postgres" }) };
  }
  const client = new Bun.SQL({ adapter: "sqlite", filename: ":memory:", safeIntegers: true });
  await client.unsafe(
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, note TEXT, flag INTEGER, a TEXT, b TEXT, c INTEGER, d REAL)",
  );
  await client.unsafe(
    "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 10000) INSERT INTO t SELECT i, 'n' || i, i / 3.0 + 0.5, i * 1000, 'note ' || i, i % 2, 'a', 'b', i, i / 7.0 + 0.5 FROM s",
  );
  return { client, db: adapter.createBunSqlDatabase(client, { dialect: "sqlite" }) };
};
const base = await open(baseAdapter);
const next = await open(nextAdapter);
const query = (n) =>
  target === "postgres"
    ? sql.rows`SELECT * FROM perf_bun WHERE id <= ${n} ORDER BY id`
    : sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`;
const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
for (const [shape, n, budget] of [
  ["point-1", 1, 500],
  ["rows-100", 100, 500],
  ["rows-10000", 10000, 1500],
]) {
  const v = {
    base: () => base.db.all(query(n)),
    next: () => next.db.all(query(n)),
  };
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
if (target === "postgres") await base.client.unsafe("DROP TABLE IF EXISTS perf_bun");
await base.client.close();
await next.client.close();
