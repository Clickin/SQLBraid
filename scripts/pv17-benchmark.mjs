#!/usr/bin/env node
import assert from "node:assert/strict";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { normalizeExactInteger, decodeExactInteger } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteDatabase, nodeSqliteStatementBinding } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const MATERIALIZED_ROWS = 100_000;
const STREAMED_ROWS = 1_000_000;
const WIDTHS = [1, 5, 10];
const TRANSPORTS = ["number", "bigint", "string"];
const TRANSFORMS = ["raw", "pv16-bigint", "pv17-string", "app-number", "app-bigint", "app-decimal"];
const MASK_64 = (1n << 64n) - 1n;
const expectedChecksums = new Map();
const TRANSPORT_SEMANTICS = {
  number: "exact-integer (guarded safe-range Number transport)",
  bigint: "exact-integer",
  string: "exact-integer",
};

class DecimalLike {
  constructor(text) {
    this.text = text;
  }
}

function memory() {
  const value = process.memoryUsage();
  return { heapUsed: value.heapUsed, rss: value.rss };
}

function maxMemory(left, right) {
  return {
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    rss: Math.max(left.rss, right.rss),
  };
}

function runtimeName() {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

function exactValueSql(transport, id) {
  if (transport === "number") return `CAST(${id} AS INTEGER)`;
  if (transport === "bigint") return `CAST(${id} AS INTEGER)`;
  return `CAST(${id} AS TEXT)`;
}

function queryFor(transport, rows, width, schema) {
  const columns = Array.from({ length: width }, (_, index) => `${exactValueSql(transport, "id")} AS v${index + 1}`).join(", ");
  const text = `
    WITH RECURSIVE nums(id) AS (
      SELECT 1
      UNION ALL
      SELECT id + 1 FROM nums WHERE id < ${rows}
    )
    SELECT ${columns} FROM nums
  `;
  const tag = schema === undefined ? sql.rows : sql.rows(schema);
  return tag`${sql.raw(text)}`;
}

const rawTypePolicy = Object.freeze({
  id: "pv17-benchmark-raw",
  hash: "pv17-benchmark-raw-v1",
  mappings: [],
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
});

const pv16TypePolicy = Object.freeze({
  id: "pv17-benchmark-pv16",
  hash: "pv17-benchmark-pv16-v1",
  mappings: [],
  decode: (_databaseType, value) => value == null ? value : decodeExactInteger(value),
  encode: (_databaseType, value) => value,
});

const pv17TypePolicy = Object.freeze({
  id: "pv17-benchmark-pv17",
  hash: "pv17-benchmark-pv17-v1",
  mappings: [],
  decode: (_databaseType, value) => value == null ? value : normalizeExactInteger(value),
  encode: (_databaseType, value) => value,
});

function plainRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return Object.fromEntries(Object.entries(value));
}

function decodeRow(row, policy) {
  return Object.fromEntries(Object.entries(plainRow(row)).map(([key, value]) => [key, policy.decode("INTEGER", value)]));
}

function createRawExecutor(native, transport, policy) {
  const ownershipKey = {};
  function prepare(rendered, binding) {
    if (!binding?.parameterizedSql) throw new Error("Benchmark binding did not materialize SQL.");
    const statement = native.prepare(binding.parameterizedSql);
    statement.setReadBigInts?.(transport === "bigint");
    return { statement, values: rendered.parameters.map((parameter) => parameter.value) };
  }
  return {
    ownershipKey,
    statementBinding: nodeSqliteStatementBinding,
    async query(rendered, binding) {
      const prepared = prepare(rendered, binding);
      const columns = prepared.statement.columns();
      if (columns.length === 0) return { rows: [], rowCount: 0, kind: "command", command: {} };
      const rows = prepared.statement.all(...prepared.values).map((row) => decodeRow(row, policy));
      return { rows, rowCount: rows.length, kind: "rows" };
    },
    async *stream(rendered, _signal, binding) {
      const prepared = prepare(rendered, binding);
      const iterator = prepared.statement.iterate?.(...prepared.values);
      if (iterator === undefined) throw new Error("Benchmark SQLite statement does not expose iteration.");
      try {
        for (const row of iterator) yield decodeRow(row, policy);
      } finally {
        iterator.return?.();
      }
    },
    async call() {
      throw new Error("BRAID_CALL_UNSUPPORTED: benchmark executor does not support calls.");
    },
  };
}

function benchmarkDatabase(native, transport, policy) {
  return createDatabase(createRawExecutor(native, transport, policy));
}

function decimalText(value) {
  assert.ok(value instanceof DecimalLike, "Decimal-like transform must return its application object.");
  return value.text;
}

function canonicalText(value) {
  if (value instanceof DecimalLike) return decimalText(value);
  if (typeof value === "number") assert.ok(Number.isSafeInteger(value), "Benchmark must not checksum an unsafe Number.");
  return normalizeExactInteger(value);
}

function transformSchema(width, transform) {
  if (transform === "raw" || transform === "pv16-bigint" || transform === "pv17-string") return undefined;
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-pv17-benchmark",
      validate(input) {
        assert.ok(input !== null && typeof input === "object" && !Array.isArray(input), "SQLBraid returned a row object.");
        const output = {};
        for (let index = 0; index < width; index += 1) {
          const key = `v${index + 1}`;
          const text = normalizeExactInteger(input[key]);
          if (transform === "app-bigint") output[key] = BigInt(text);
          else if (transform === "app-number") {
            const number = Number(text);
            assert.ok(Number.isSafeInteger(number), "Number application transform would lose integer fidelity.");
            output[key] = number;
          } else if (transform === "app-decimal") output[key] = new DecimalLike(text);
          else output[key] = text;
        }
        return { value: output };
      },
    },
  };
}

function expectedChecksum(rows, width) {
  const key = `${rows}:${width}`;
  const cached = expectedChecksums.get(key);
  if (cached !== undefined) return cached;
  let checksum = 0n;
  for (let id = 1n; id <= BigInt(rows); id += 1n) {
    for (let column = 1n; column <= BigInt(width); column += 1n) {
      checksum = (checksum + id * column) & MASK_64;
    }
  }
  expectedChecksums.set(key, checksum);
  return checksum;
}

function checksumRow(checksum, row, width) {
  for (let index = 0; index < width; index += 1) {
    checksum = (checksum + BigInt(canonicalText(row[`v${index + 1}`])) * BigInt(index + 1)) & MASK_64;
  }
  return checksum;
}

function representation(value) {
  if (value instanceof DecimalLike) return "decimal-like";
  if (value === null) return "null";
  return typeof value;
}

function sampleRows(rows, width) {
  const first = rows[0];
  const last = rows.at(-1);
  assert.ok(first !== undefined && last !== undefined, "Materialized benchmark returned no rows.");
  for (let index = 0; index < width; index += 1) {
    assert.equal(canonicalText(first[`v${index + 1}`]), "1");
    assert.equal(canonicalText(last[`v${index + 1}`]), String(rows.length));
  }
}

async function allowGc() {
  if (typeof globalThis.gc !== "function") return false;
  globalThis.gc();
  await new Promise((resolve) => setImmediate(resolve));
  return true;
}

function makeGcObserver() {
  const events = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) events.push({ duration: entry.duration, kind: entry.detail?.kind });
  });
  observer.observe({ entryTypes: ["gc"] });
  return { events, observer };
}

function metric(before, after, peak, wallMs, rows, rawRepresentation, transform, kind, width) {
  return {
    kind,
    path: "SQLBraid createDatabase + raw SQLite executor + TypePolicy.decode",
    rows,
    width,
    transport: rawRepresentation.transport,
    transportSemantics: TRANSPORT_SEMANTICS[rawRepresentation.transport],
    rawRepresentation: rawRepresentation.observed,
    transform,
    wallMs: Number(wallMs.toFixed(3)),
    rowsPerSecond: Number((rows / (wallMs / 1_000)).toFixed(1)),
    heapUsedBeforeBytes: before.heapUsed,
    heapUsedAfterBytes: after.heapUsed,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssBeforeBytes: before.rss,
    rssAfterBytes: after.rss,
    rssDeltaBytes: after.rss - before.rss,
    peakRssBytes: peak.rss,
    peakHeapUsedBytes: peak.heapUsed,
  };
}

async function runMaterialized(db, transport, rawObserved, rows, width, transform, gcEvents) {
  await allowGc();
  const gcStart = gcEvents.length;
  const schema = transformSchema(width, transform);
  const query = queryFor(transport, rows, width, schema);
  const before = memory();
  let peak = before;
  const started = performance.now();
  const result = await db.all(query);
  peak = maxMemory(peak, memory());
  assert.equal(result.length, rows);
  const executionMs = performance.now() - started;
  const verificationStarted = performance.now();
  sampleRows(result, width);
  let checksum = 0n;
  for (const row of result) {
    checksum = checksumRow(checksum, row, width);
    if ((checksum & 0x3fffn) === 0n) peak = maxMemory(peak, memory());
  }
  const verificationMs = performance.now() - verificationStarted;
  const after = memory();
  assert.equal(checksum, expectedChecksum(rows, width), "Materialized checksum changed.");
  await new Promise((resolve) => setImmediate(resolve));
  const output = metric(before, after, peak, executionMs, rows, { transport, observed: rawObserved }, transform, "materialized", width);
  output.checksum = `0x${checksum.toString(16).padStart(16, "0")}`;
  output.verificationMs = Number(verificationMs.toFixed(3));
  output.verificationMode = "post-materialization checksum";
  output.gcCount = gcEvents.length - gcStart;
  output.gcDurationMs = Number(gcEvents.slice(gcStart).reduce((sum, event) => sum + event.duration, 0).toFixed(3));
  return output;
}

async function runStream(db, transport, rawObserved, rows, width, transform, gcEvents) {
  await allowGc();
  const gcStart = gcEvents.length;
  const schema = transformSchema(width, transform);
  const query = queryFor(transport, rows, width, schema);
  const before = memory();
  let peak = before;
  let count = 0;
  let checksum = 0n;
  const started = performance.now();
  for await (const row of db.stream(query)) {
    checksum = checksumRow(checksum, row, width);
    count += 1;
    if ((count & 0x3fff) === 0) peak = maxMemory(peak, memory());
  }
  const after = memory();
  const executionMs = performance.now() - started;
  assert.equal(count, rows);
  assert.equal(checksum, expectedChecksum(rows, width), "Stream checksum changed.");
  await new Promise((resolve) => setImmediate(resolve));
  const output = metric(before, after, peak, executionMs, rows, { transport, observed: rawObserved }, transform, "stream", width);
  output.checksum = `0x${checksum.toString(16).padStart(16, "0")}`;
  output.verificationMs = 0;
  output.verificationMode = "inline checksum while consuming stream";
  output.gcCount = gcEvents.length - gcStart;
  output.gcDurationMs = Number(gcEvents.slice(gcStart).reduce((sum, event) => sum + event.duration, 0).toFixed(3));
  return output;
}

function rawDriverProbe(native) {
  const numberStatement = native.prepare("SELECT CAST(1 AS INTEGER) AS value");
  numberStatement.setReadBigInts?.(false);
  const number = numberStatement.get().value;
  const bigintStatement = native.prepare("SELECT CAST(9007199254740993 AS INTEGER) AS value");
  bigintStatement.setReadBigInts?.(true);
  const bigint = bigintStatement.get().value;
  const string = native.prepare("SELECT CAST(9007199254740993 AS TEXT) AS value").get().value;
  assert.equal(typeof number, "number");
  assert.equal(bigint, 9007199254740993n);
  assert.equal(typeof string, "string");
  return {
    number: { type: typeof number, value: number },
    bigint: { type: typeof bigint, value: String(bigint) },
    string: { type: typeof string, value: string },
  };
}

async function main() {
  const native = new DatabaseSync(":memory:");
  const { events, observer } = makeGcObserver();
  try {
    const rawProbe = rawDriverProbe(native);
    for (const width of WIDTHS) expectedChecksum(MATERIALIZED_ROWS, width);
    expectedChecksum(STREAMED_ROWS, 5);
    const sqliteDb = createNodeSqliteDatabase(native);
    const sqlbraidRaw = {};
    for (const transport of TRANSPORTS) {
      const row = await sqliteDb.one(queryFor(transport, 1, 1));
      sqlbraidRaw[transport] = representation(row.v1);
    }
    const correctness = await sqliteDb.one(sql.rows`${sql.raw("SELECT CAST(9007199254740993 AS INTEGER) AS value")}`);
    assert.equal(normalizeExactInteger(correctness.value), "9007199254740993");
    const workloads = [];
    for (const transport of TRANSPORTS) {
      for (const width of WIDTHS) {
        for (const transform of TRANSFORMS) {
          const policy = transform === "raw" ? rawTypePolicy : transform === "pv16-bigint" ? pv16TypePolicy : pv17TypePolicy;
          const db = benchmarkDatabase(native, transport, policy);
          workloads.push(await runMaterialized(db, transport, rawProbe[transport].type, MATERIALIZED_ROWS, width, transform, events));
          await db.finish?.();
        }
      }
      for (const transform of TRANSFORMS) {
        const policy = transform === "raw" ? rawTypePolicy : transform === "pv16-bigint" ? pv16TypePolicy : pv17TypePolicy;
        const db = benchmarkDatabase(native, transport, policy);
        workloads.push(await runStream(db, transport, rawProbe[transport].type, STREAMED_ROWS, 5, transform, events));
        await db.finish?.();
      }
    }
    await sqliteDb.finish?.();
    observer.disconnect();
    console.log(JSON.stringify({
      benchmark: "pv17-value-fidelity",
      runtime: { id: runtimeName(), version: process.version },
      command: "node scripts/pv17-benchmark.mjs",
      forcedGc: typeof globalThis.gc === "function",
      rawDriverProbe: rawProbe,
      sqlbraidRawRepresentation: sqlbraidRaw,
      correctness: { wideExactInteger: "9007199254740993", checksum: "BigInt 64-bit modular sum" },
      workloads,
      observations: [
        "PV16-style exact integers use a TypePolicy.decode path that returns BigInt; PV17 uses a TypePolicy.decode path that returns strings.",
        "Number, BigInt and Decimal-like transforms are application-owned Standard Schema mappings after the raw SQLBraid boundary.",
        "The Number transport uses integral safe-range INTEGER values with native bigint reads disabled; it is reported as guarded exact-integer transport.",
        "RSS and heap peaks are sampled between rows for streams and around materialization; GC metrics are observational and depend on Node flags/runtime scheduling.",
      ],
    }, null, 2));
  } finally {
    observer.disconnect();
    native.close();
  }
}

await main();
