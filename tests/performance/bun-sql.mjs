// Bun.SQL vs SQLBraid. Run with Bun: bun tests/performance/bun-sql.mjs <sqlite|postgres> [rounds]
// postgres needs SQLBRAID_PERF_URL for the dedicated benchmark database.
import { createBunSqlDatabase } from "@sqlbraid/bun-sql";

const target = process.argv[2];
const rounds = Number(process.argv[3] ?? 7);
let client;
let sql;
let seed;
if (target === "sqlite") {
  ({ sql } = await import("@sqlbraid/sqlite"));
  client = new Bun.SQL({ adapter: "sqlite", filename: ":memory:", safeIntegers: true });
  seed = async () => {
    await client.unsafe(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, note TEXT, flag INTEGER, a TEXT, b TEXT, c INTEGER, d REAL)",
    );
    await client.unsafe(
      "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 10000) INSERT INTO t SELECT i, 'n' || i, i / 3.0 + 0.5, i * 1000, 'note ' || i, i % 2, 'a', 'b', i, i / 7.0 + 0.5 FROM s",
    );
  };
} else if (target === "postgres") {
  const url = process.env.SQLBRAID_PERF_URL;
  if (url === undefined) throw new Error("Set SQLBRAID_PERF_URL to the dedicated benchmark database.");
  ({ sql } = await import("@sqlbraid/postgres"));
  client = new Bun.SQL(url, { bigint: true });
  seed = async () => {
    await client.unsafe("DROP TABLE IF EXISTS perf_bun");
    await client.unsafe(
      "CREATE TABLE perf_bun AS SELECT i::int8 AS id, 'n' || i AS name, (i / 3.0 + 0.5)::float8 AS amount, (i * 1000)::int8 AS big, 'note ' || i AS note, (i % 2)::int8 AS flag, 'a' AS a, 'b' AS b, i::int8 AS c, (i / 7.0 + 0.5)::float8 AS d FROM generate_series(1, 10000) AS i",
    );
    await client.unsafe("ALTER TABLE perf_bun ADD PRIMARY KEY (id)");
  };
} else {
  throw new Error("Usage: bun tests/performance/bun-sql.mjs <sqlite|postgres> [rounds]");
}
await seed();
const table = target === "sqlite" ? "t" : "perf_bun";
const db = createBunSqlDatabase(client, { dialect: target });
const placeholder = target === "sqlite" ? "?" : "$1";
const text = `SELECT * FROM ${table} WHERE id <= ${placeholder} ORDER BY id`;
const braidQuery = (n) =>
  target === "sqlite"
    ? sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`
    : sql.rows`SELECT * FROM perf_bun WHERE id <= ${n} ORDER BY id`;

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
async function time(run, budgetMs) {
  for (let i = 0; i < 20; i += 1) await run();
  const t0 = performance.now();
  let calls = 0;
  while (performance.now() - t0 < budgetMs) {
    await run();
    calls += 1;
  }
  return ((performance.now() - t0) * 1000) / calls;
}
try {
  for (const [shape, n] of [
    ["point-1", 1],
    ["rows-100", 100],
    ["rows-10000", 10000],
  ]) {
    const v = { unsafe: () => client.unsafe(text, [n]), braid: () => db.all(braidQuery(n)) };
    const names = Object.keys(v);
    const per = Object.fromEntries(names.map((name) => [name, []]));
    for (let round = 0; round < rounds; round += 1) {
      for (const name of round % 2 === 0 ? names : names.toReversed())
        per[name].push(await time(v[name], n === 10000 ? 1500 : 500));
    }
    const m = Object.fromEntries(names.map((name) => [name, median(per[name])]));
    console.log(
      `bun-sql ${target} ${shape.padEnd(11)} unsafe ${m.unsafe.toFixed(1).padStart(9)}us  braid ${m.braid.toFixed(1).padStart(9)}us  braid/unsafe ${(m.braid / m.unsafe).toFixed(3)}`,
    );
  }
} finally {
  if (target === "postgres") await client.unsafe("DROP TABLE IF EXISTS perf_bun");
  await client.close();
}
