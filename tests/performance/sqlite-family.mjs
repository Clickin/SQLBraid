// Driver-vs-SQLBraid overhead for libSQL, SQLite WASM and D1 (Miniflare). In-memory databases show the library cost.
// Usage: node tests/performance/sqlite-family.mjs <libsql|wasm|d1> [rounds]
import { performance } from "node:perf_hooks";
import { sql } from "@sqlbraid/sqlite";

const target = process.argv[2];
const rounds = Number(process.argv[3] ?? 7);
const schema = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, note TEXT, flag INTEGER, a TEXT, b TEXT, c INTEGER, d REAL)`;
const text = "SELECT * FROM t WHERE id <= ? ORDER BY id";
const rowValues = (i) => [i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7];
const toObjects = (names, rows) =>
  rows.map((row) => {
    const object = {};
    for (let i = 0; i < names.length; i += 1) object[names[i]] = row[i];
    return object;
  });
const braidQuery = (n) => sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`;

let cleanup = async () => {};
let variants;
if (target === "libsql") {
  const { createClient } = await import("@libsql/client/node");
  const { createLibsqlDatabase } = await import("@sqlbraid/sqlite/libsql");
  const client = createClient({ url: ":memory:", intMode: "string" });
  await client.execute(schema);
  const statements = [];
  for (let i = 1; i <= 10000; i += 1) {
    statements.push({ sql: "INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)", args: rowValues(i) });
  }
  await client.batch(statements, "write");
  const db = createLibsqlDatabase(client, { intMode: "string" });
  variants = (n) => ({
    execute: () => client.execute({ sql: text, args: [n] }),
    executeObjects: async () => {
      const result = await client.execute({ sql: text, args: [n] });
      return toObjects(result.columns, result.rows);
    },
    braid: () => db.all(braidQuery(n)),
  });
  cleanup = async () => client.close();
} else if (target === "wasm") {
  const { default: sqlite3InitModule } = await import("@sqlite.org/sqlite-wasm");
  const { createSqliteWasmDatabase } = await import("@sqlbraid/sqlite/wasm");
  const sqlite3 = await sqlite3InitModule();
  const native = new sqlite3.oo1.DB(":memory:");
  native.exec(schema);
  native.exec("BEGIN");
  for (let i = 1; i <= 10000; i += 1) {
    native.exec({ sql: "INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)", bind: rowValues(i) });
  }
  native.exec("COMMIT");
  const db = createSqliteWasmDatabase(native, { sqlite3 });
  variants = (n) => ({
    execute: () => native.exec({ sql: text, bind: [n], rowMode: "object", returnValue: "resultRows" }),
    executeArrayToObjects: () => {
      const names = [];
      const rows = native.exec({
        sql: text,
        bind: [n],
        rowMode: "array",
        returnValue: "resultRows",
        columnNames: names,
      });
      return toObjects(names, rows);
    },
    braid: () => db.all(braidQuery(n)),
  });
  cleanup = async () => native.close();
} else if (target === "d1") {
  const { Miniflare } = await import("miniflare");
  const { createD1Database } = await import("@sqlbraid/sqlite/d1");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await d1.exec(schema.replace(/\s+/g, " "));
  for (let start = 1; start <= 10000; start += 500) {
    const batch = [];
    for (let i = start; i < start + 500; i += 1) {
      batch.push(d1.prepare("INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)").bind(...rowValues(i)));
    }
    await d1.batch(batch);
  }
  const db = createD1Database(d1);
  variants = (n) => ({
    all: () => d1.prepare(text).bind(n).all(),
    braid: () => db.all(braidQuery(n)),
  });
  cleanup = async () => mf.dispose();
} else {
  throw new Error("Usage: node tests/performance/sqlite-family.mjs <libsql|wasm|d1> [rounds]");
}

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
    const v = variants(n);
    const names = Object.keys(v);
    const per = Object.fromEntries(names.map((name) => [name, []]));
    for (let round = 0; round < rounds; round += 1) {
      for (const name of round % 2 === 0 ? names : names.toReversed())
        per[name].push(await time(v[name], n === 10000 ? 1500 : 500));
    }
    const m = Object.fromEntries(names.map((name) => [name, median(per[name])]));
    const base = names.at(-2);
    console.log(
      `${target} ${shape.padEnd(11)} ${names
        .slice(0, -1)
        .map((name) => `${name} ${m[name].toFixed(1).padStart(9)}us`)
        .join("  ")}  braid ${m.braid.toFixed(1).padStart(9)}us  braid/${base} ${(m.braid / m[base]).toFixed(3)}`,
    );
  }
} finally {
  await cleanup();
}
