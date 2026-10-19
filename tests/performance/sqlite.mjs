// SQLite driver-vs-SQLBraid overhead. In-memory database: no I/O, so library cost is the visible part.
// Usage: node tests/performance/sqlite.mjs [rounds]
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import Better from "better-sqlite3";
import { sql } from "@sqlbraid/sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { createBetterSqlite3Database } from "@sqlbraid/sqlite/better-sqlite3";

const rounds = Number(process.argv[2] ?? 7);
const schema = `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount REAL, big INTEGER, note TEXT, flag INTEGER, a TEXT, b TEXT, c INTEGER, d REAL);`;
function seed(db) {
  db.exec(schema);
  const insert = db.prepare("INSERT INTO t VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= 10000; i += 1) insert.run(i, `n${i}`, i / 3, i * 1000, `note ${i}`, i % 2, "a", "b", i, i / 7);
}
const node = new DatabaseSync(":memory:");
const better = new Better(":memory:");
seed(node);
seed(better);
const sbNode = createNodeSqliteDatabase(node);
const sbBetter = createBetterSqlite3Database(better);

const shapes = [
  ["point-1", 1],
  ["rows-100", 100],
  ["rows-10000", 10000],
];
const targets = {
  "node:sqlite": {
    raw: (n) => {
      const stmt = node.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id");
      return () => stmt.all(n);
    },
    rawPrepare: (n) => () => node.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id").all(n),
    rawExact: (n) => () => {
      const stmt = node.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id");
      stmt.setReadBigInts(true);
      return stmt.all(n);
    },
    braid: (n) => () => sbNode.all(sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`),
  },
  "better-sqlite3": {
    raw: (n) => {
      const stmt = better.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id");
      return () => stmt.all(n);
    },
    rawPrepare: (n) => () => better.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id").all(n),
    rawExact: (n) => () => {
      const stmt = better.prepare("SELECT * FROM t WHERE id <= ? ORDER BY id");
      stmt.safeIntegers(true);
      stmt.raw(true);
      return stmt.all(n).map((row) => row.map((v) => (typeof v === "bigint" ? v.toString() : v)));
    },
    braid: (n) => () => sbBetter.all(sql.rows`SELECT * FROM t WHERE id <= ${n} ORDER BY id`),
  },
};

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

async function time(run, budgetMs) {
  for (let i = 0; i < 30; i += 1) await run();
  const t0 = performance.now();
  let calls = 0;
  while (performance.now() - t0 < budgetMs) {
    await run();
    calls += 1;
  }
  return ((performance.now() - t0) * 1000) / calls;
}

for (const [driver, impl] of Object.entries(targets)) {
  for (const [shape, n] of shapes) {
    const variants = {
      raw: impl.raw(n),
      rawPrepare: impl.rawPrepare(n),
      rawExact: impl.rawExact(n),
      braid: impl.braid(n),
    };
    const names = Object.keys(variants);
    const per = Object.fromEntries(names.map((name) => [name, []]));
    for (let round = 0; round < rounds; round += 1) {
      const order = round % 2 === 0 ? names : names.toReversed();
      for (const name of order) per[name].push(await time(variants[name], 250));
    }
    const m = Object.fromEntries(names.map((name) => [name, median(per[name])]));
    console.log(
      `${driver.padEnd(15)} ${shape.padEnd(11)} raw ${m.raw.toFixed(1).padStart(8)}us  raw+prepare ${m.rawPrepare.toFixed(1).padStart(8)}us  raw+prepare+bigint ${m.rawExact.toFixed(1).padStart(8)}us  braid ${m.braid.toFixed(1).padStart(8)}us  braid/raw+prepare+bigint ${(m.braid / m.rawExact).toFixed(3)}`,
    );
  }
}
