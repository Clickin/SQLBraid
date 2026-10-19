// MariaDB driver-vs-SQLBraid overhead against a dedicated local container.
// Usage: SQLBRAID_PERF_MARIADB_URL=mariadb://... node tests/performance/mariadb.mjs [rounds]
import { performance } from "node:perf_hooks";
import mariadb from "mariadb";
import { MARIADB_LOSSLESS_TEXT, sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const url = process.env.SQLBRAID_PERF_MARIADB_URL;
if (url === undefined) throw new Error("Set SQLBRAID_PERF_MARIADB_URL to the dedicated benchmark database.");
const rounds = Number(process.argv[2] ?? 7);
const options = {
  ...MARIADB_LOSSLESS_TEXT.connectionOptions,
  host: "127.0.0.1",
  port: Number(new URL(url).port),
  user: "root",
  password: new URL(url).password,
  database: new URL(url).pathname.slice(1),
};

const seedConn = await mariadb.createConnection(options);
await seedConn.query("DROP TABLE IF EXISTS perf_t");
await seedConn.query(
  "CREATE TABLE perf_t (id INT PRIMARY KEY, name VARCHAR(32), amount DOUBLE, big BIGINT, note TEXT, flag TINYINT, a VARCHAR(8), b VARCHAR(8), c INT, d DOUBLE)",
);
const rowsToInsert = [];
for (let i = 1; i <= 10000; i += 1)
  rowsToInsert.push([i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7]);
for (let i = 0; i < rowsToInsert.length; i += 1000) {
  await seedConn.batch("INSERT INTO perf_t VALUES (?,?,?,?,?,?,?,?,?,?)", rowsToInsert.slice(i, i + 1000));
}
await seedConn.end();

const rawConn = await mariadb.createConnection(options);
const braidConn = await mariadb.createConnection(options);
const braid = createMariaDbDatabase(braidConn);

const text = "SELECT * FROM perf_t WHERE id <= ? ORDER BY id";
const shapes = [
  ["point-1", 1],
  ["rows-100", 100],
  ["rows-10000", 10000],
];
const variants = (n) => ({
  execute: () => rawConn.execute(text, [n]),
  executeArray: () => rawConn.execute({ sql: text, rowsAsArray: true, metaAsArray: true }, [n]),
  executeObjects: async () => {
    const [rows, meta] = await rawConn.execute({ sql: text, rowsAsArray: true, metaAsArray: true }, [n]);
    const names = meta.map((column) => column.name());
    return rows.map((row) => {
      const object = {};
      for (let i = 0; i < names.length; i += 1) object[names[i]] = row[i];
      return object;
    });
  },
  braid: () => braid.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`),
});

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
  for (const [shape, n] of shapes) {
    const v = variants(n);
    const names = Object.keys(v);
    const per = Object.fromEntries(names.map((name) => [name, []]));
    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0 ? names : names.toReversed();
      for (const name of order) per[name].push(await time(v[name], n === 10000 ? 1500 : 500));
    }
    const m = Object.fromEntries(names.map((name) => [name, median(per[name])]));
    console.log(
      `${shape.padEnd(11)} execute ${m.execute.toFixed(1).padStart(9)}us  executeArray ${m.executeArray.toFixed(1).padStart(9)}us  executeObjects ${m.executeObjects.toFixed(1).padStart(9)}us  braid ${m.braid.toFixed(1).padStart(9)}us  braid/execute ${(m.braid / m.execute).toFixed(3)}  braid/executeObjects ${(m.braid / m.executeObjects).toFixed(3)}`,
    );
  }
} finally {
  await rawConn.end();
  await braidConn.end();
}
