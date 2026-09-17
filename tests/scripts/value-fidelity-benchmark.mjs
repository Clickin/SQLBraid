#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { normalizeExactInteger, decodeExactInteger, UnsupportedFeatureError } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import { createNodeSqliteDatabase, nodeSqliteStatementBinding } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

const PROFILE_DEFAULTS = Object.freeze({
  full: Object.freeze({
    materializedRows: 100_000,
    streamedRows: 1_000_000,
    warmupIterations: 1,
    measuredRepeats: 3,
  }),
  smoke: Object.freeze({
    materializedRows: 10_000,
    streamedRows: 100_000,
    warmupIterations: 0,
    measuredRepeats: 1,
  }),
});
const WIDTHS = [1, 5, 10];
const TRANSPORTS = ["number", "bigint", "string"];
const TRANSFORMS = ["raw", "exact-bigint", "exact-string", "app-number", "app-bigint", "app-decimal"];
const STREAM_WIDTH = 5;
const MASK_64 = (1n << 64n) - 1n;
const expectedChecksums = new Map();
const TRANSPORT_SEMANTICS = {
  number: "exact-integer (guarded safe-range Number transport)",
  bigint: "exact-integer",
  string: "exact-integer",
};

function parseArguments(args) {
  let profile;
  let transport;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--profile" || argument === "--transport" || argument === "--output") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--profile") profile = value;
      else if (argument === "--transport") transport = value;
      else output = value;
      continue;
    }
    if (argument.startsWith("--profile=")) profile = argument.slice("--profile=".length);
    else if (argument.startsWith("--transport=")) transport = argument.slice("--transport=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (profile !== undefined && !Object.hasOwn(PROFILE_DEFAULTS, profile)) {
    throw new Error(`Unknown profile "${profile}". Expected smoke or full.`);
  }
  if (profile === "") throw new Error("Profile cannot be empty.");
  if (transport === "") throw new Error("Transport cannot be empty.");
  if (output === "") throw new Error("Output path cannot be empty.");
  return { profile: profile ?? "full", transport, output };
}

const CLI = parseArguments(process.argv.slice(2));
const PROFILE = CLI.profile;
const PROFILE_DEFAULT = PROFILE_DEFAULTS[PROFILE];

function resolveTransport(cliTransport) {
  if (process.env.SQLBRAID_VALUE_FIDELITY_CHILD === "1") {
    const childTransport = process.env.SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT;
    if (!TRANSPORTS.includes(childTransport)) {
      throw new Error("SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT must be number, bigint, or string.");
    }
    return childTransport;
  }
  const transport = cliTransport ?? process.env.SQLBRAID_VALUE_FIDELITY_TRANSPORT ?? "all";
  if (!["all", ...TRANSPORTS].includes(transport)) {
    throw new Error(`Unknown transport "${transport}". Expected number, bigint, string, or all.`);
  }
  return transport;
}

const SELECTED_TRANSPORT = resolveTransport(CLI.transport);
const ACTIVE_TRANSPORTS = SELECTED_TRANSPORT === "all" ? TRANSPORTS : [SELECTED_TRANSPORT];
const MATERIALIZED_ROWS = positiveInteger(
  "SQLBRAID_VALUE_FIDELITY_MATERIALIZED_ROWS",
  PROFILE_DEFAULT.materializedRows,
);
const STREAMED_ROWS = positiveInteger("SQLBRAID_VALUE_FIDELITY_STREAMED_ROWS", PROFILE_DEFAULT.streamedRows);
const WARMUP_ITERATIONS = nonNegativeInteger("SQLBRAID_VALUE_FIDELITY_WARMUPS", PROFILE_DEFAULT.warmupIterations);
const MEASURED_REPEATS = positiveInteger("SQLBRAID_VALUE_FIDELITY_REPEATS", PROFILE_DEFAULT.measuredRepeats);
const SHUFFLE_SEED = positiveInteger("SQLBRAID_VALUE_FIDELITY_SEED", 18_092_026);
const ISOLATION = process.env.SQLBRAID_VALUE_FIDELITY_ISOLATION ?? "family";
const OUTPUT_PATH = CLI.output;

function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer.`);
  return parsed;
}

function nonNegativeInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return parsed;
}

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
  return (
    process.release?.name ?? (typeof Bun !== "undefined" ? "bun" : typeof Deno !== "undefined" ? "deno" : "unknown")
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function invocationMetadata() {
  const script = process.argv[1];
  const commandArgs = [
    process.execPath,
    ...process.execArgv,
    ...(script === undefined ? [] : [script]),
    ...process.argv.slice(2),
  ];
  return {
    command: commandArgs.map(shellQuote).join(" "),
    executable: process.execPath,
    execArgv: [...process.execArgv],
    argv: [...process.argv],
    runtime: runtimeName(),
    version: process.version,
    platform: process.platform,
    architecture: process.arch,
    pid: process.pid,
  };
}

function exactValueSql(transport, id) {
  if (transport === "number") return `CAST(${id} AS INTEGER)`;
  if (transport === "bigint") return `CAST(${id} AS INTEGER)`;
  return `CAST(${id} AS TEXT)`;
}

function queryFor(transport, rows, width, schema) {
  const columns = Array.from(
    { length: width },
    (_, index) => `${exactValueSql(transport, "id")} AS v${index + 1}`,
  ).join(", ");
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
  id: "value-fidelity-raw-v1",
  hash: "value-fidelity-raw-v1",
  mappings: [],
  decode: (_databaseType, value) => value,
  encode: (_databaseType, value) => value,
});

const exactBigIntTypePolicy = Object.freeze({
  id: "value-fidelity-exact-bigint-v1",
  hash: "value-fidelity-exact-bigint-v1",
  mappings: [],
  decode: (_databaseType, value) => (value == null ? value : decodeExactInteger(value)),
  encode: (_databaseType, value) => value,
});

const exactStringTypePolicy = Object.freeze({
  id: "value-fidelity-exact-string-v1",
  hash: "value-fidelity-exact-string-v1",
  mappings: [],
  decode: (_databaseType, value) => (value == null ? value : normalizeExactInteger(value)),
  encode: (_databaseType, value) => value,
});

function plainRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return Object.fromEntries(Object.entries(value));
}

function decodeRow(row, policy) {
  return Object.fromEntries(
    Object.entries(plainRow(row)).map(([key, value]) => [key, policy.decode("INTEGER", value)]),
  );
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
    async *stream(rendered, binding) {
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
      throw new UnsupportedFeatureError(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "Benchmark executor does not support calls.",
      );
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
  if (typeof value === "number")
    assert.ok(Number.isSafeInteger(value), "Benchmark must not checksum an unsafe Number.");
  return normalizeExactInteger(value);
}

function transformSchema(width, transform) {
  if (transform === "raw" || transform === "exact-bigint" || transform === "exact-string") return undefined;
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-value-fidelity-benchmark",
      validate(input) {
        assert.ok(
          input !== null && typeof input === "object" && !Array.isArray(input),
          "SQLBraid returned a row object.",
        );
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
  const rowCount = BigInt(rows);
  const columnCount = BigInt(width);
  const rowSum = (rowCount * (rowCount + 1n)) / 2n;
  const columnSum = (columnCount * (columnCount + 1n)) / 2n;
  const checksum = (rowSum * columnSum) & MASK_64;
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

function caseId(transport, kind, rows, width, transform) {
  return `${transport}/${kind}/${rows}/${width}/${transform}`;
}

function makeCases(transport) {
  const cases = [];
  for (const width of WIDTHS) {
    for (const transform of TRANSFORMS) {
      cases.push({ transport, kind: "materialized", rows: MATERIALIZED_ROWS, width, transform });
    }
  }
  for (const transform of TRANSFORMS) {
    cases.push({ transport, kind: "stream", rows: STREAMED_ROWS, width: STREAM_WIDTH, transform });
  }
  return cases;
}

function shuffledCases(cases, iteration, transportIndex) {
  const result = [...cases];
  let state = (SHUFFLE_SEED + iteration * 1_000_003 + transportIndex * 97) >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function spread(values) {
  return { min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) };
}

function summarize(workloads) {
  const grouped = new Map();
  for (const workload of workloads) {
    const key = workload.caseId;
    const group = grouped.get(key) ?? [];
    group.push(workload);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const first = group[0];
    const wallMs = group.map((item) => item.wallMs);
    const rssDeltaBytes = group.map((item) => item.rssDeltaBytes);
    const peakRssBytes = group.map((item) => item.peakRssBytes);
    return {
      caseId: first.caseId,
      kind: first.kind,
      rows: first.rows,
      width: first.width,
      transport: first.transport,
      transform: first.transform,
      iterations: group.length,
      wallMsMedian: Number(median(wallMs).toFixed(3)),
      wallMsSpread: spread(wallMs),
      rssDeltaBytesMedian: median(rssDeltaBytes),
      rssDeltaBytesSpread: spread(rssDeltaBytes),
      peakRssBytesMedian: median(peakRssBytes),
      peakRssBytesSpread: spread(peakRssBytes),
      checksum: first.checksum,
    };
  });
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
  const output = metric(
    before,
    after,
    peak,
    executionMs,
    rows,
    { transport, observed: rawObserved },
    transform,
    "materialized",
    width,
  );
  output.checksum = `0x${checksum.toString(16).padStart(16, "0")}`;
  output.verificationMs = Number(verificationMs.toFixed(3));
  output.verificationMode = "post-materialization checksum";
  output.gcCount = gcEvents.length - gcStart;
  output.gcDurationMs = Number(
    gcEvents
      .slice(gcStart)
      .reduce((sum, event) => sum + event.duration, 0)
      .toFixed(3),
  );
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
  const output = metric(
    before,
    after,
    peak,
    executionMs,
    rows,
    { transport, observed: rawObserved },
    transform,
    "stream",
    width,
  );
  output.checksum = `0x${checksum.toString(16).padStart(16, "0")}`;
  output.verificationMs = 0;
  output.verificationMode = "inline checksum while consuming stream";
  output.gcCount = gcEvents.length - gcStart;
  output.gcDurationMs = Number(
    gcEvents
      .slice(gcStart)
      .reduce((sum, event) => sum + event.duration, 0)
      .toFixed(3),
  );
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

function policyFor(transform) {
  return transform === "raw"
    ? rawTypePolicy
    : transform === "exact-bigint"
      ? exactBigIntTypePolicy
      : exactStringTypePolicy;
}

async function runCase(native, transport, rawObserved, workload, events) {
  const db = benchmarkDatabase(native, transport, policyFor(workload.transform));
  try {
    if (workload.kind === "materialized") {
      return await runMaterialized(
        db,
        transport,
        rawObserved,
        workload.rows,
        workload.width,
        workload.transform,
        events,
      );
    }
    return await runStream(db, transport, rawObserved, workload.rows, workload.width, workload.transform, events);
  } finally {
    await db.finish?.();
  }
}

async function runFamily(transport, transportIndex) {
  const native = new DatabaseSync(":memory:");
  const { events, observer } = makeGcObserver();
  const invocation = invocationMetadata();
  try {
    const rawProbe = rawDriverProbe(native);
    const sqliteDb = createNodeSqliteDatabase(native);
    const row = await sqliteDb.one(queryFor(transport, 1, 1));
    const sqlbraidRaw = { [transport]: representation(row.v1) };
    const correctness = await sqliteDb.one(sql.rows`${sql.raw("SELECT CAST(9007199254740993 AS INTEGER) AS value")}`);
    assert.equal(normalizeExactInteger(correctness.value), "9007199254740993");
    await sqliteDb.finish?.();

    const cases = makeCases(transport);
    const workloads = [];
    async function runCycle(iteration, record) {
      const ordered = shuffledCases(cases, iteration, transportIndex);
      for (const [orderIndex, workload] of ordered.entries()) {
        const result = await runCase(native, transport, rawProbe[transport].type, workload, events);
        if (record) {
          result.caseId = caseId(workload.transport, workload.kind, workload.rows, workload.width, workload.transform);
          result.iteration = iteration;
          result.orderIndex = orderIndex;
          result.processId = invocation.pid;
          workloads.push(result);
        }
      }
    }
    for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) await runCycle(iteration, false);
    for (let iteration = 1; iteration <= MEASURED_REPEATS; iteration += 1) await runCycle(iteration, true);

    observer.disconnect();
    return {
      transport,
      invocation,
      rawDriverProbe: { [transport]: rawProbe[transport] },
      sqlbraidRawRepresentation: sqlbraidRaw,
      correctness: { wideExactInteger: "9007199254740993", checksum: "BigInt 64-bit modular sum" },
      workloads,
    };
  } finally {
    observer.disconnect();
    native.close();
  }
}

function resolvedMethodology() {
  return {
    profile: PROFILE,
    transport: SELECTED_TRANSPORT,
    transports: ACTIVE_TRANSPORTS,
    warmupIterations: WARMUP_ITERATIONS,
    measuredRepeats: MEASURED_REPEATS,
    measuredIterations: MEASURED_REPEATS,
    deterministicSeed: SHUFFLE_SEED,
    order: "seeded Fisher-Yates shuffle per transport and iteration",
    isolation: ISOLATION,
    materializedRows: MATERIALIZED_ROWS,
    streamedRows: STREAMED_ROWS,
    widths: [...WIDTHS],
    streamWidth: STREAM_WIDTH,
    transforms: [...TRANSFORMS],
  };
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

function emitResult(result) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (OUTPUT_PATH === undefined) process.stdout.write(json);
  else {
    writeJsonAtomically(OUTPUT_PATH, json);
    console.error(`Wrote value-fidelity benchmark output to ${resolve(OUTPUT_PATH)}`);
  }
}

function runFamilyProcess(transport, transportIndex) {
  return new Promise((resolve, reject) => {
    const script = process.argv[1];
    if (script === undefined) {
      reject(new Error("Value-fidelity benchmark requires a script path for family isolation."));
      return;
    }
    const child = spawn(
      process.execPath,
      [...process.execArgv, script, "--profile", PROFILE, "--transport", transport],
      {
        env: {
          ...process.env,
          SQLBRAID_VALUE_FIDELITY_CHILD: "1",
          SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT: transport,
          SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT_INDEX: String(transportIndex),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status !== 0) {
        reject(
          new Error(
            `Value-fidelity benchmark child failed for ${transport} (exit ${status ?? signal}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Value-fidelity benchmark child emitted invalid JSON for ${transport}: ${error.message}`));
      }
    });
  });
}

async function main() {
  if (ISOLATION !== "family" && ISOLATION !== "none") {
    throw new Error("SQLBRAID_VALUE_FIDELITY_ISOLATION must be family or none.");
  }
  if (process.env.SQLBRAID_VALUE_FIDELITY_CHILD === "1") {
    const transport = process.env.SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT;
    if (!TRANSPORTS.includes(transport)) throw new Error("SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT is invalid.");
    const family = await runFamily(transport, Number(process.env.SQLBRAID_VALUE_FIDELITY_CHILD_TRANSPORT_INDEX ?? 0));
    process.stdout.write(
      `${JSON.stringify(
        {
          benchmark: "value-fidelity",
          schemaVersion: 2,
          profile: PROFILE,
          role: "family",
          methodology: resolvedMethodology(),
          ...family,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // Each family is an isolated child process; run them concurrently without sharing DB or heap state.
  const families =
    ISOLATION === "family"
      ? await Promise.all(
          ACTIVE_TRANSPORTS.map((transport) => runFamilyProcess(transport, TRANSPORTS.indexOf(transport))),
        )
      : [];
  if (ISOLATION === "none") {
    for (const transport of ACTIVE_TRANSPORTS) families.push(await runFamily(transport, TRANSPORTS.indexOf(transport)));
  }
  const workloads = families.flatMap((family) => family.workloads);
  const rawDriverProbe = Object.assign({}, ...families.map((family) => family.rawDriverProbe));
  const sqlbraidRawRepresentation = Object.assign({}, ...families.map((family) => family.sqlbraidRawRepresentation));
  emitResult({
    benchmark: "value-fidelity",
    schemaVersion: 2,
    profile: PROFILE,
    methodology: resolvedMethodology(),
    invocation: invocationMetadata(),
    runtime: {
      id: runtimeName(),
      version: process.version,
      platform: process.platform,
      architecture: process.arch,
      execArgv: [...process.execArgv],
    },
    forcedGc: typeof globalThis.gc === "function",
    rawDriverProbe,
    sqlbraidRawRepresentation,
    correctness: { wideExactInteger: "9007199254740993", checksum: "BigInt 64-bit modular sum" },
    processes: families.map(({ transport, invocation }) => ({ transport, ...invocation })),
    workloads,
    summary: summarize(workloads),
    observations: [
      "Exact-integer BigInt decoding uses the SQLBraid TypePolicy decode path.",
      "Exact-integer string normalization uses the SQLBraid TypePolicy decode path.",
      "Number, BigInt and Decimal-like application transforms are application-owned Standard Schema mappings after the raw SQLBraid boundary.",
      "The Number transport uses integral safe-range INTEGER values with native bigint reads disabled; it is reported as guarded exact-integer transport.",
      "Every measured case validates row count, boundary samples and a modular BigInt checksum before its metric is retained.",
      "Wall-clock summaries reflect the configured observation count; no performance threshold or release claim is applied.",
      ISOLATION === "family"
        ? "RSS and heap metrics are observational within fresh transport-family processes; they are not a sequential peak-RSS performance claim."
        : "RSS and heap metrics are observational in one process; do not interpret sequential peak-RSS differences as memory performance.",
    ],
  });
}

await main();
