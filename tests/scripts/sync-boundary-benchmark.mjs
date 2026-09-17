#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase, createNodeSqliteExecutor } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const ITERATIONS = 5_000;
const WARMUPS = 100;
const native = new DatabaseSync(":memory:");
const nativeStatement = native.prepare("SELECT ? AS value");
const executor = createNodeSqliteExecutor(native);
const db = createNodeSqliteDatabase(native);
const query = (value) => sql.rows`SELECT ${value} AS value`;

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
    throw new Error(`Could not write benchmark output to ${target}.`, { cause: error });
  }
}

function readNative(value) {
  const row = nativeStatement.get(value);
  assert.equal(String(row.value), String(value));
  return Number(row.value);
}

async function readExecutor(value) {
  const renderedQuery = query(value);
  const rendered = renderedQuery.render();
  const binding = executor.statementBinding.describe(rendered, {
    dialectId: rendered.dialectId,
    requestedReuse: "auto",
  });
  const result = await executor.query(rendered, binding);
  assert.equal(result.kind, "rows");
  assert.equal(result.rows.length, 1);
  assert.equal(String(result.rows[0].value), String(value));
  return Number(result.rows[0].value);
}

async function readPublic(value) {
  const rows = await db.all(query(value));
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].value), String(value));
  return Number(rows[0].value);
}

async function measure(name, read) {
  for (let index = 1; index <= WARMUPS; index += 1) await read(index);
  const started = performance.now();
  let checksum = 0;
  for (let index = 1; index <= ITERATIONS; index += 1) checksum += await read(index);
  const elapsedMs = performance.now() - started;
  assert.equal(checksum, (ITERATIONS * (ITERATIONS + 1)) / 2, `${name} returned an unexpected checksum`);
  return {
    name,
    iterations: ITERATIONS,
    checksum,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    operationsPerSecond: Number((ITERATIONS / (elapsedMs / 1_000)).toFixed(1)),
  };
}

try {
  const results = [
    await measure("native", readNative),
    await measure("query-executor", readExecutor),
    await measure("public-database", readPublic),
  ];
  const json = `${JSON.stringify({
    benchmark: "sync-boundary",
    schemaVersion: 1,
    iterations: ITERATIONS,
    warmups: WARMUPS,
    note: "Diagnostic only; timings are reported without a pass/fail threshold.",
    results,
  }, null, 2)}\n`;
  const output = outputPath();
  if (output === undefined) console.log(json.trimEnd());
  else {
    writeJsonAtomically(output, json);
    console.error(`Wrote sync-boundary benchmark output to ${resolve(output)}`);
  }
} finally {
  native.close();
}
