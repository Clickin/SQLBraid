// MySQL point-query cost by layer: mysql2 call, adapter executor, Database. Usage: node tests/performance/mysql-layers.mjs [rounds]
import { performance } from "node:perf_hooks";
import { createConnection } from "mysql2/promise";
import { createRenderedStatement } from "@sqlbraid/core";
import { MYSQL2_NATIVE, sql } from "@sqlbraid/mysql";
import { createMysql2Database, createMysql2Executor } from "@sqlbraid/mysql/mysql2";

const url = process.env.SQLBRAID_PERF_MYSQL_URL;
if (url === undefined) throw new Error("Set SQLBRAID_PERF_MYSQL_URL to the dedicated benchmark database.");
const rounds = Number(process.argv[2] ?? 9);
const connection = await createConnection({ uri: url, ...MYSQL2_NATIVE.connectionOptions });
const quietConnection = await createConnection({ uri: url, ...MYSQL2_NATIVE.connectionOptions, trace: false });
const quietDatabase = createMysql2Database(quietConnection);
const executor = createMysql2Executor(connection);
const database = createMysql2Database(connection);
const query = sql.rows`SELECT * FROM perf_t WHERE id <= ${1} ORDER BY id`;
const rendered = createRenderedStatement({
  segments: ["SELECT * FROM perf_t WHERE id <= ", " ORDER BY id"],
  parameters: [{ value: 1 }],
  dialectId: "mysql",
  resultKind: "rows",
});
const binding = executor.statementBinding.describe(rendered, { dialectId: "mysql", requestedReuse: "reuse" });
const text = "SELECT * FROM perf_t WHERE id <= ? ORDER BY id";
const variants = {
  raw: () => connection.execute({ sql: text, values: [1], rowsAsArray: true, disableEval: true }),
  rawQuiet: () => quietConnection.execute({ sql: text, values: [1], rowsAsArray: true, disableEval: true }),
  databaseQuiet: () => quietDatabase.all(query),
  executor: () => executor.query(rendered, binding),
  database: () => database.all(query),
};
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const names = Object.keys(variants);
const per = Object.fromEntries(names.map((name) => [name, []]));
const cpu = Object.fromEntries(names.map((name) => [name, []]));
try {
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? names : names.toReversed();
    for (const name of order) {
      for (let i = 0; i < 300; i += 1) await variants[name]();
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      for (let i = 0; i < 4000; i += 1) await variants[name]();
      per[name].push(((performance.now() - start) * 1000) / 4000);
      const used = process.cpuUsage(cpuStart);
      cpu[name].push((used.user + used.system) / 4000);
    }
  }
  for (const name of names) {
    console.log(name.padEnd(9), "wall", median(per[name]).toFixed(1), "us  cpu", median(cpu[name]).toFixed(1), "us");
  }
  const paired = (a, b, values) => median(values[a].map((v, i) => v - values[b][i]));
  console.log(
    "paired wall database-raw",
    paired("database", "raw", per).toFixed(1),
    "executor-raw",
    paired("executor", "raw", per).toFixed(1),
  );
  console.log(
    "paired cpu  database-raw",
    paired("database", "raw", cpu).toFixed(1),
    "executor-raw",
    paired("executor", "raw", cpu).toFixed(1),
  );
} finally {
  await connection.end();
  await quietConnection.end();
}
