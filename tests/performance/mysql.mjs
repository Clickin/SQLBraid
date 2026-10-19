// MySQL driver-vs-SQLBraid overhead against a dedicated local container.
// Usage: SQLBRAID_PERF_MYSQL_URL=mysql://... node tests/performance/mysql.mjs [rounds]
import { performance } from "node:perf_hooks";
import { createConnection } from "mysql2/promise";
import { MYSQL2_NATIVE, sql } from "@sqlbraid/mysql";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";

const url = process.env.SQLBRAID_PERF_MYSQL_URL;
if (url === undefined) throw new Error("Set SQLBRAID_PERF_MYSQL_URL to the dedicated benchmark database.");
const rounds = Number(process.argv[2] ?? 7);
const options = { uri: url, ...MYSQL2_NATIVE.connectionOptions };

const seedConn = await createConnection(options);
await seedConn.query("DROP TABLE IF EXISTS perf_t");
await seedConn.query(
  "CREATE TABLE perf_t (id INT PRIMARY KEY, name VARCHAR(32), amount DOUBLE, big BIGINT, note TEXT, flag TINYINT, a VARCHAR(8), b VARCHAR(8), c INT, d DOUBLE)",
);
const rowsToInsert = [];
for (let i = 1; i <= 10000; i += 1)
  rowsToInsert.push([i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7]);
for (let i = 0; i < rowsToInsert.length; i += 1000) {
  await seedConn.query("INSERT INTO perf_t VALUES ?", [rowsToInsert.slice(i, i + 1000)]);
}
await seedConn.end();

const rawConn = await createConnection(options);
const braidConn = await createConnection(options);
const braid = createMysql2Database(braidConn);

const text = "SELECT * FROM perf_t WHERE id <= ? ORDER BY id";
const shapes = [
  ["point-1", 1],
  ["rows-100", 100],
  ["rows-10000", 10000],
];
const variants = (n) => ({
  query: async () => (await rawConn.query(text, [n]))[0],
  execute: async () => (await rawConn.execute(text, [n]))[0],
  executeArray: async () => (await rawConn.execute({ sql: text, values: [n], rowsAsArray: true }))[0],
  noEvalArray: async () => (await rawConn.execute({ sql: text, values: [n], rowsAsArray: true, disableEval: true }))[0],
  noEvalObjects: async () => {
    const [rows, fields] = await rawConn.execute({ sql: text, values: [n], rowsAsArray: true, disableEval: true });
    const names = fields.map((field) => field.name);
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
      `${shape.padEnd(11)} query ${m.query.toFixed(1).padStart(9)}us  execute ${m.execute.toFixed(1).padStart(9)}us  executeArray ${m.executeArray.toFixed(1).padStart(9)}us  noEvalArray ${m.noEvalArray.toFixed(1).padStart(9)}us  noEvalObjects ${m.noEvalObjects.toFixed(1).padStart(9)}us  braid ${m.braid.toFixed(1).padStart(9)}us  braid/execute ${(m.braid / m.execute).toFixed(3)}  braid/executeArray ${(m.braid / m.executeArray).toFixed(3)}`,
    );
  }
} finally {
  await rawConn.end();
  await braidConn.end();
}
