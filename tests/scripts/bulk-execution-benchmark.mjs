#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const sizes = [1, 10, 100, 1_000];
const native = new DatabaseSync(":memory:");
native.exec("CREATE TABLE braid_bulk_execution_benchmark (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)");
const seed = native.prepare("INSERT INTO braid_bulk_execution_benchmark (id, amount) VALUES (?, 0)");
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
      setReadBigInts:
        statement.setReadBigInts === undefined ? undefined : (enabled) => statement.setReadBigInts(enabled),
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
    UPDATE braid_bulk_execution_benchmark
    SET amount = amount + ${input.amount}
    WHERE id = ${input.id}
  `;
}

function outputPath() {
  const args = process.argv.slice(2);
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--output") {
      output = args[++index];
      if (output === undefined || output.length === 0) throw new Error("--output requires a file path.");
    } else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
      if (output.length === 0) throw new Error("--output requires a file path.");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return output;
}

function writeJsonAtomically(path, json) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, json);
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the write failure.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not write benchmark output to ${target}: ${message}`, { cause: error });
  }
}

async function measure(size, mode) {
  native.exec("UPDATE braid_bulk_execution_benchmark SET amount = 0");
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
  const total = native
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM braid_bulk_execution_benchmark")
    .get().total;
  assert.equal(total, size, `${mode} execution changed the wrong number of rows for N=${size}`);
  assert.equal(runCount, size, `${mode} execution did not execute one item per input for N=${size}`);
  if (mode === "bulk") assert.equal(prepareCount, 1, `bulk must prepare once for N=${size}`);
  else assert.equal(prepareCount, size, `independent execution must prepare once per item for N=${size}`);
  return { mode, n: size, wallMs: Number(wallMs.toFixed(3)), prepareCount, runCount };
}

try {
  const output = outputPath();
  const results = [];
  for (const size of sizes) {
    results.push(await measure(size, "independent"));
    results.push(await measure(size, "bulk"));
  }
  const json = `${JSON.stringify({ benchmark: "bulk-execution", schemaVersion: 1, results }, null, 2)}\n`;
  if (output === undefined) console.log(json.trimEnd());
  else {
    writeJsonAtomically(output, json);
    console.error(`Wrote bulk-execution benchmark output to ${resolve(output)}`);
  }
} finally {
  native.close();
}
