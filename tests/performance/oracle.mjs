// Oracle driver-vs-SQLBraid overhead against a dedicated local container.
// Usage: SQLBRAID_PERF_ORACLE_URL=127.0.0.1:51521/FREEPDB1 SQLBRAID_PERF_ORACLE_PASSWORD=... node tests/performance/oracle.mjs [rounds]
import { performance } from "node:perf_hooks";
import oracledb from "oracledb";
import { sql } from "@sqlbraid/oracle";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";

const connectString = process.env.SQLBRAID_PERF_ORACLE_URL;
const password = process.env.SQLBRAID_PERF_ORACLE_PASSWORD;
if (connectString === undefined || password === undefined) {
  throw new Error(
    "Set SQLBRAID_PERF_ORACLE_URL and SQLBRAID_PERF_ORACLE_PASSWORD for the dedicated benchmark database.",
  );
}
const rounds = Number(process.argv[2] ?? 7);
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

const rawConn = await oracledb.getConnection(credentials);
const braidConn = await oracledb.getConnection(credentials);
const braid = createOracledbDatabase(braidConn);

// The same fetch conversion that the SQLBraid adapter selects: NUMBER as string, array rows.
const exact = {
  outFormat: oracledb.OUT_FORMAT_ARRAY,
  fetchTypeHandler: (metadata) => (metadata.dbType === oracledb.DB_TYPE_NUMBER ? { type: oracledb.STRING } : undefined),
};
const text = "SELECT * FROM perf_t WHERE id <= :1 ORDER BY id";
const shapes = [
  ["point-1", 1],
  ["rows-100", 100],
  ["rows-10000", 10000],
];
const variants = (n) => ({
  execute: () => rawConn.execute(text, [n]),
  executeExactArray: () => rawConn.execute(text, [n], exact),
  executeExactObjects: async () => {
    const result = await rawConn.execute(text, [n], exact);
    const names = result.metaData.map((column) => column.name);
    return result.rows.map((row) => {
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
      `${shape.padEnd(11)} execute ${m.execute.toFixed(1).padStart(9)}us  exactArray ${m.executeExactArray.toFixed(1).padStart(9)}us  exactObjects ${m.executeExactObjects.toFixed(1).padStart(9)}us  braid ${m.braid.toFixed(1).padStart(9)}us  braid/execute ${(m.braid / m.execute).toFixed(3)}  braid/exactObjects ${(m.braid / m.executeExactObjects).toFixed(3)}`,
    );
  }
} finally {
  await rawConn.close();
  await braidConn.close();
}
