#!/usr/bin/env node
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const sizes = [1, 10, 100, 1_000];
const native = new DatabaseSync(":memory:");
native.exec("CREATE TABLE braid_pv16_benchmark (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
const seed = native.prepare("INSERT INTO braid_pv16_benchmark (id, amount) VALUES (?, 0)");
for (let id = 1; id <= 1_000; id += 1) seed.run(id);

let prepareCount = 0;
let runCount = 0;
const countedDatabase = {
  prepare(text) {
    prepareCount += 1;
    const statement = native.prepare(text);
    return {
      all: (...values) => statement.all(...values),
      columns: () => statement.columns(),
      iterate: statement.iterate === undefined ? undefined : (...values) => statement.iterate(...values),
      run: (...values) => {
        runCount += 1;
        return statement.run(...values);
      },
      setReadBigInts: statement.setReadBigInts === undefined ? undefined : (enabled) => statement.setReadBigInts(enabled),
    };
  },
  exec(text) {
    native.exec(text);
  },
};
const db = createNodeSqliteDatabase(countedDatabase);

function inputs(size) {
  return Array.from({ length: size }, (_, index) => ({ id: index + 1, amount: 1 }));
}

function command(input) {
  return sql.command`
    UPDATE braid_pv16_benchmark
    SET amount = amount + ${input.amount}
    WHERE id = ${input.id}
  `;
}

async function measure(size, mode) {
  native.exec("UPDATE braid_pv16_benchmark SET amount = 0");
  prepareCount = 0;
  runCount = 0;
  const values = inputs(size);
  const started = performance.now();
  if (mode === "independent") {
    for (const input of values) await db.execute(command(input));
  } else {
    await db.bulk(values, (input) => command(input));
  }
  const wallMs = performance.now() - started;
  const total = native.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM braid_pv16_benchmark").get().total;
  assert.equal(total, size, `${mode} execution changed the wrong number of rows for N=${size}`);
  assert.equal(runCount, size, `${mode} execution did not execute one item per input for N=${size}`);
  if (mode === "bulk") assert.equal(prepareCount, 1, `bulk must prepare once for N=${size}`);
  else assert.equal(prepareCount, size, `independent execution must prepare once per item for N=${size}`);
  return { mode, n: size, wallMs: Number(wallMs.toFixed(3)), prepareCount, runCount };
}

try {
  const results = [];
  for (const size of sizes) {
    results.push(await measure(size, "independent"));
    results.push(await measure(size, "bulk"));
  }
  console.log(JSON.stringify({ benchmark: "pv16-bulk", results }, null, 2));
} finally {
  native.close();
}
