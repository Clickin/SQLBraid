// SQL Server driver-vs-SQLBraid overhead against a dedicated local container.
// Usage: SQLBRAID_PERF_MSSQL_PORT=51433 SQLBRAID_PERF_MSSQL_PASSWORD=... node tests/performance/mssql.mjs [rounds]
import { performance } from "node:perf_hooks";
import { Connection, Request, TYPES } from "tedious";
import { sql } from "@sqlbraid/mssql";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";

const port = Number(process.env.SQLBRAID_PERF_MSSQL_PORT);
const password = process.env.SQLBRAID_PERF_MSSQL_PASSWORD;
if (!Number.isInteger(port) || password === undefined) {
  throw new Error(
    "Set SQLBRAID_PERF_MSSQL_PORT and SQLBRAID_PERF_MSSQL_PASSWORD for the dedicated benchmark database.",
  );
}
const rounds = Number(process.argv[2] ?? 7);

function connect() {
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
}
function run(connection, text, parameters = [], onRow) {
  return new Promise((resolve, reject) => {
    const request = new Request(text, (error) => (error ? reject(error) : resolve()));
    for (const [name, type, value] of parameters) request.addParameter(name, type, value);
    if (onRow) request.on("row", onRow);
    connection.execSql(request);
  });
}

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

const rawConn = await connect();
const braidConn = await connect();
const braid = createTediousDatabase(braidConn);

const text = "SELECT * FROM perf_t WHERE id <= @p0 ORDER BY id";
const shapes = [
  ["point-1", 1],
  ["rows-100", 100],
  ["rows-10000", 10000],
];
const variants = (n) => ({
  execSql: async () => {
    let count = 0;
    await run(rawConn, text, [["p0", TYPES.Int, n]], () => {
      count += 1;
    });
    return count;
  },
  rowsArray: async () => {
    const rows = [];
    await run(rawConn, text, [["p0", TYPES.Int, n]], (columns) => rows.push(columns.map((column) => column.value)));
    return rows;
  },
  rowsObjects: async () => {
    const rows = [];
    await run(rawConn, text, [["p0", TYPES.Int, n]], (columns) => {
      const object = {};
      for (const column of columns) object[column.metadata.colName] = column.value;
      rows.push(object);
    });
    return rows;
  },
  braid: () => braid.all(sql.rows`SELECT * FROM perf_t WHERE id <= ${n} ORDER BY id`),
});

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
async function time(call, budgetMs) {
  for (let i = 0; i < 20; i += 1) await call();
  const t0 = performance.now();
  let calls = 0;
  while (performance.now() - t0 < budgetMs) {
    await call();
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
      `${shape.padEnd(11)} execSql ${m.execSql.toFixed(1).padStart(9)}us  rowsArray ${m.rowsArray.toFixed(1).padStart(9)}us  rowsObjects ${m.rowsObjects.toFixed(1).padStart(9)}us  braid ${m.braid.toFixed(1).padStart(9)}us  braid/rowsObjects ${(m.braid / m.rowsObjects).toFixed(3)}`,
    );
  }
} finally {
  rawConn.close();
  braidConn.close();
}
