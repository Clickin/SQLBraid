// Run after the workspace build: node --expose-gc tests/driver-extraction/benchmark.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createStatementBindingDescription, parameterizedSql } from "@sqlbraid/core";
import { preparePositionalResultProjector } from "@sqlbraid/core/driver";
import { createDatabase } from "@sqlbraid/runtime";
import { sql as pgSql, typePolicy as pgPolicy } from "@sqlbraid/postgres";
import { sql as sqliteSql } from "@sqlbraid/sqlite";
import { createPgDatabase } from "../../packages/postgres/dist/pg.js";
import { createNodeSqliteDatabase } from "../../packages/sqlite/dist/node-sqlite.js";
import { createPgDatabase as baselinePg } from "../performance/.builds/extraction-baseline/postgres/pg.js";
import { createNodeSqliteDatabase as baselineSqlite } from "../performance/.builds/extraction-baseline/sqlite/node-sqlite.js";
import { pgConnection, pgPool } from "../../experiments/driver-extraction/dist/pg.js";
import { sqliteConnection } from "../../experiments/driver-extraction/dist/sqlite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "docs/driver-extraction/performance-results.json");
const require = createRequire(import.meta.url);
const rounds = Number(process.env.EXTRACTION_BENCH_ROUNDS ?? 7);
const budgetMs = Number(process.env.EXTRACTION_BENCH_MS ?? 150);
const warmup = Number(process.env.EXTRACTION_BENCH_WARMUP ?? 20);
assert.ok(Number.isInteger(rounds) && rounds >= 5, "At least five rounds are required");
assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, "EXTRACTION_BENCH_MS must be positive");
assert.ok(Number.isInteger(warmup) && warmup >= 1, "Warmup must be a positive integer");
const gcEvents = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gcEvents.push({ startMs: entry.startTime, durationMs: entry.duration, kind: entry.detail.kind });
});
observer.observe({ entryTypes: ["gc"] });
const report = {
  startedAt: new Date().toISOString(),
  baselineCommit: "a99811f82ca80c0a230975fef82ddfda5c925e71",
  environment: {
    node: process.version,
    versions: process.versions,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    pg: require("pg/package.json").version,
    execArgv: process.execArgv,
  },
  settings: { rounds, budgetMs, warmup, explicitGc: typeof global.gc === "function" },
  methodology: {
    scope:
      "Materialized queries only; dedicated disposable PostgreSQL container and in-memory node:sqlite. One sequential process and physical connection per engine shared by all variants; no simultaneous operations.",
    baseline:
      "Saved driver bundles only; baseline and current use the same current core/runtime dependencies resolved from tests/node_modules. This isolates driver extraction, not a whole-release comparison.",
    scheduling:
      "Each case warms every variant, then rotates the first variant each round and reverses on odd rounds. Timed loops await every operation, including synchronous SQLite. Row checks run outside timing before warmup and after all rounds.",
    timing:
      "Each sample is elapsed client wall time divided by operations in a fixed-duration batch. Native IO+materialization includes server execution, network, client protocol handling and materialization; these are NOT individually measurable here. Stage diagnostics are independent operations, not an additive decomposition of end-to-end latency.",
    semantics:
      "All variants use positional native rows. PostgreSQL integer OIDs use lossless text parsing. SQLite reads bigint and prepares anew on every operation; no prepared cache. Native/extracted raw results retain positional rows and native metadata; normalized variants and all SQLBraid variants return named rows with exact integers as strings. Native raw timings are lower-semantic-work references, not equivalent SQLBraid replacements.",
    fixture:
      "id, text label, >2^53 exact integer, and nullable text. Range reads of 1/100/10000 rows, indexed point lookup, and idempotent one-row UPDATE without RETURNING. No JSON/temporal/decimal/stream/prepare/bulk claims.",
    memory:
      "heapDeltaBytes measures heapUsed after minus before each timed batch (explicit GC before batch when available). It is not allocated bytes or retained bytes; collection may make it negative. GC entries are observed process-wide pauses overlapping a sample, not attribution to a library or allocation counts. Explicit pre-sample GC lies outside the timing window.",
    acquisition:
      "PostgreSQL acquisition diagnostics use one warmed dedicated pool, acquire+release with no SQL, separately from pinned-connection query cases. SQLite has no provider acquisition; opening/closing a database is deliberately not substituted.",
    bridge:
      "Benchmark-local materialized QueryExecutor: public SQLBraid binding/rendering/runtime, real extracted Connection IO, public PostgreSQL TypePolicy decoding, and SQLite bigint-to-string projection. Unsupported hints/routines/streaming/cancellation are rejected, not emulated. Projection is fixture-focused and not a production adapter.",
  },
  engines: {},
  cases: [],
};

function summarize(samples) {
  const values = samples.map((sample) => sample.microsecondsPerOperation).toSorted((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(values.length / 2);
  return {
    median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    mean,
    stddev: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    unit: "microseconds/operation",
    samples,
  };
}

async function measure(run, round, order) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startMs = performance.now();
  let operations = 0;
  do {
    await run();
    operations++;
  } while (performance.now() - startMs < budgetMs);
  const endMs = performance.now();
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((done) => setImmediate(done));
  return {
    round,
    order,
    operations,
    startMs,
    endMs,
    elapsedMs: endMs - startMs,
    microsecondsPerOperation: ((endMs - startMs) * 1000) / operations,
    heapDeltaBytes,
  };
}

async function benchmark(engine, name, stage, variants, check) {
  const names = Object.keys(variants);
  const samples = Object.fromEntries(names.map((key) => [key, []]));
  for (const key of names) {
    if (check) check(await variants[key](), key);
    for (let count = 0; count < warmup; count++) await variants[key]();
  }
  for (let round = 0; round < rounds; round++) {
    const rotated = [...names.slice(round % names.length), ...names.slice(0, round % names.length)];
    const order = round % 2 ? rotated.toReversed() : rotated;
    for (const [position, key] of order.entries()) samples[key].push(await measure(variants[key], round, position));
  }
  for (const key of names) if (check) check(await variants[key](), key);
  const result = {
    engine,
    name,
    stage,
    variants: Object.fromEntries(names.map((key) => [key, summarize(samples[key])])),
  };
  report.cases.push(result);
  console.log(
    `${engine} ${name} [${stage}] ${names.map((key) => `${key}=${result.variants[key].median.toFixed(2)}us`).join(" ")}`,
  );
}

const decodeInteger = (value) => (typeof value === "bigint" ? value.toString() : value);

// The fixture has unique simple column names; projection intentionally makes no claim about exotic metadata.
function project(result, engine) {
  const columns = result.columns;
  const projector = preparePositionalResultProjector(
    columns.map((column, index) => {
      let decode = decodeInteger;
      if (engine === "postgres") {
        const dataType =
          column.dataTypeID === 20
            ? "int8"
            : column.dataTypeID === 23
              ? "int4"
              : column.dataTypeID === 25
                ? "text"
                : undefined;
        if (dataType === undefined) throw new Error(`Unexpected benchmark column OID: ${column.dataTypeID}`);
        decode = (value) => pgPolicy.decode(dataType, value);
      }
      return { name: column.name, index, decode };
    }),
    result.rows.length,
  );
  const rows = result.rows.map(projector);
  if (columns.length > 0 || result.command === "SELECT") return { kind: "rows", rows, rowCount: rows.length };
  const affectedRows = result.affectedRows === undefined ? undefined : Number(result.affectedRows);
  return {
    kind: "command",
    rows: [],
    rowCount: affectedRows,
    command: {
      ...(affectedRows === undefined ? {} : { affectedRows }),
      ...(result.insertId === undefined ? {} : { insertId: String(result.insertId) }),
    },
  };
}

function bridge(connection, engine) {
  const placeholder = engine === "postgres" ? (index) => `$${index}` : () => "?";
  const statementBinding = {
    id: `extraction-benchmark-${engine}`,
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: this.id,
        transport: "text-positional",
        placeholder,
        reuse: { effective: "simple", owner: "sqlbraid" },
      });
    },
  };
  const bind = (statement, description) => {
    if (
      statement.resultKind === "call" ||
      statement.parameters.some(
        (parameter) =>
          parameter.hint !== undefined || (parameter.direction !== undefined && parameter.direction !== "in"),
      )
    )
      throw new Error("Benchmark bridge does not support routines or parameter hints");
    return {
      sql: description?.parameterizedSql ?? parameterizedSql(statement, placeholder),
      parameters: statement.parameters.map((parameter) => parameter.value),
    };
  };
  const executor = {
    statementBinding,
    environment: {
      database: { product: engine },
      driver: { id: "extraction-benchmark", profile: "materialized-exact-integers" },
      capabilities: {
        "session.pinned": { status: "guaranteed" },
        transaction: { status: "unsupported" },
        "statement.prepare": { status: "unsupported" },
      },
    },
    async query(statement, description, options) {
      if (options?.signal) throw new Error("Benchmark bridge does not support cancellation");
      return project(await connection.execute(bind(statement, description)), engine);
    },
    async *stream() {
      throw new Error("Benchmark bridge does not support streaming");
    },
    call() {
      throw new Error("Benchmark bridge does not support routine calls");
    },
    begin() {
      throw new Error("Benchmark bridge compares materialized statements only");
    },
    commit() {
      throw new Error("Benchmark bridge compares materialized statements only");
    },
    rollback() {
      throw new Error("Benchmark bridge compares materialized statements only");
    },
  };
  return { database: createDatabase(executor), statementBinding, bind };
}

function shapes(engine) {
  const sql = engine === "postgres" ? pgSql : sqliteSql;
  const marker = engine === "postgres" ? "$1" : "?";
  return [
    ...[1, 100, 10000].map((count) => ({
      name: `rows-${count}`,
      count,
      statement: {
        sql: `SELECT id, label, exact_value, nullable FROM extraction_rows WHERE id <= ${marker} ORDER BY id`,
        parameters: [count],
      },
      query: () =>
        sql.rows`SELECT id, label, exact_value, nullable FROM extraction_rows WHERE id <= ${count} ORDER BY id`,
    })),
    {
      name: "point",
      count: 1,
      point: true,
      statement: {
        sql: `SELECT id, label, exact_value, nullable FROM extraction_rows WHERE id = ${marker}`,
        parameters: [5000],
      },
      query: () => sql.rows`SELECT id, label, exact_value, nullable FROM extraction_rows WHERE id = ${5000}`,
    },
    {
      name: "update",
      command: true,
      statement: { sql: `UPDATE extraction_rows SET label = 'row-1' WHERE id = ${marker}`, parameters: [1] },
      query: () => sql.command`UPDATE extraction_rows SET label = 'row-1' WHERE id = ${1}`,
    },
  ];
}

function checkResult(result, variant, shape, engine) {
  const raw = variant === "native" || variant === "extracted";
  if (shape.command) {
    assert.equal(Number(raw ? result.affectedRows : result.command.affectedRows), 1);
    if (!raw) assert.equal(result.kind, "command");
    assert.equal(result.rows.length, 0);
    return;
  }
  assert.equal(result.rows.length, shape.count);
  if (!raw) assert.equal(result.kind, "rows");
  for (let index = 0; index < shape.count; index++) {
    const id = shape.point ? 5000 : index + 1;
    const expected = { id: String(id), label: `row-${id}`, exact_value: "9007199254740993", nullable: null };
    if (raw) {
      assert.deepEqual(
        result.rows[index],
        engine === "postgres" ? Object.values(expected) : [BigInt(id), expected.label, 9007199254740993n, null],
      );
    } else assert.deepEqual(result.rows[index], expected);
  }
}

async function runEngine(engine, native, connection, baseline, current) {
  const adapter = bridge(connection, engine);
  for (const shape of shapes(engine)) {
    const variants = {
      native: () => native(shape.statement),
      "baseline-sqlbraid": () => baseline.execute(shape.query()),
      extracted: () => connection.execute(shape.statement),
      "current-sqlbraid": () => current.execute(shape.query()),
      "sqlbraid-bridge": () => adapter.database.execute(shape.query()),
      "native-normalized": async () => project(await native(shape.statement), engine),
      "extracted-normalized": async () => project(await connection.execute(shape.statement), engine),
    };
    await benchmark(engine, shape.name, "end-to-end", variants, (result, variant) =>
      checkResult(result, variant, shape, engine),
    );
    const rendered = shape.query().render();
    const description = adapter.statementBinding.describe(rendered, { dialectId: engine, requestedReuse: "auto" });
    const materialized = await native(shape.statement);
    await benchmark(engine, shape.name, "render", { "template+render": () => shape.query().render() });
    await benchmark(engine, shape.name, "binding", {
      "describe+bind": () =>
        adapter.bind(
          rendered,
          adapter.statementBinding.describe(rendered, { dialectId: engine, requestedReuse: "auto" }),
        ),
      "bind-existing-description": () => adapter.bind(rendered, description),
    });
    await benchmark(
      engine,
      shape.name,
      "native-io+materialization",
      { native: () => native(shape.statement) },
      (result) => checkResult(result, "native", shape, engine),
    );
    await benchmark(
      engine,
      shape.name,
      "consumer-transformation",
      { "cached-native-to-sqlbraid": () => project(materialized, engine) },
      (result) => checkResult(result, "normalized", shape, engine),
    );
  }
}

const cleanup = [];
try {
  const target = JSON.parse(await readFile(resolve(root, "support/targets/postgres.json"), "utf8"));
  const image = target.reproducibility.image;
  // Never connect to a user-supplied database: the benchmark owns this container and all its data.
  const container = await new PostgreSqlContainer(image).withDatabase("extraction_benchmark").start();
  cleanup.push(() => container.stop());
  const types = {
    getTypeParser(oid, format) {
      return [20, 21, 23].includes(oid) && format !== "binary" ? (value) => value : pg.types.getTypeParser(oid, format);
    },
  };
  const config = { connectionString: container.getConnectionUri(), types };
  const client = new pg.Client(config);
  await client.connect();
  cleanup.push(() => client.end());
  await client.query(
    "CREATE TABLE extraction_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, exact_value BIGINT NOT NULL, nullable TEXT)",
  );
  await client.query(
    "INSERT INTO extraction_rows SELECT i, 'row-' || i, 9007199254740993, NULL FROM generate_series(1, 10000) AS i",
  );
  await client.query("ANALYZE extraction_rows");
  const nativePg = async (statement) => {
    const result = await client.query({ text: statement.sql, values: statement.parameters, rowMode: "array" });
    return {
      rows: result.rows,
      columns: result.fields,
      affectedRows: result.rowCount ?? undefined,
      command: result.command,
    };
  };
  // Native row-mode configuration only; the extracted driver itself does no SQLBraid decoding.
  const pgConn = pgConnection({
    query: (request) => client.query({ ...request, rowMode: "array" }),
    escapeIdentifier: client.escapeIdentifier.bind(client),
    escapeLiteral: client.escapeLiteral.bind(client),
    end: () => client.end(),
  });
  cleanup[cleanup.length - 1] = () => pgConn.release();
  report.engines.postgres = {
    image,
    version: (await client.query("SELECT version() AS version")).rows[0].version,
    rows: "array",
    integers: "text",
    connection: "single pinned client; pool acquisition measured separately",
  };
  const nativeDefaults = await client.query({ text: "SELECT 42::int4 AS id", types: pg.types });
  assert.equal(nativeDefaults.rows[0].id, 42);
  const sqlbraidDefaults = await createPgDatabase(client).execute(pgSql.rows`SELECT 42::int4 AS id`);
  assert.equal(sqlbraidDefaults.rows[0].id, "42");
  report.engines.postgres.nativeDefaultInt4 = "number; timed variants explicitly use lossless text for policy parity";
  await runEngine("postgres", nativePg, pgConn, baselinePg(client), createPgDatabase(client));
  const pool = new pg.Pool({ ...config, max: 1 });
  cleanup.push(() => pool.end());
  const provider = pgPool(pool);
  await benchmark("postgres", "pool", "acquire+release", {
    native: async () => {
      const lease = await pool.connect();
      lease.release();
    },
    extracted: async () => {
      const lease = await provider.acquire();
      await lease.release();
    },
  });

  const sqlite = new DatabaseSync(":memory:");
  cleanup.push(() => sqlite.close());
  sqlite.exec(
    "CREATE TABLE extraction_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, exact_value INTEGER NOT NULL, nullable TEXT); BEGIN",
  );
  const insert = sqlite.prepare("INSERT INTO extraction_rows VALUES (?, ?, ?, NULL)");
  for (let id = 1; id <= 10000; id++) insert.run(id, `row-${id}`, 9007199254740993n);
  sqlite.exec("COMMIT; ANALYZE");
  assert.equal(
    typeof sqlite.prepare("SELECT 1").setReturnArrays,
    "function",
    "Use a Node version with node:sqlite setReturnArrays for consistent positional row modes",
  );
  const prepare = (text) => {
    const statement = sqlite.prepare(text);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    return statement;
  };
  const nativeSqlite = (statement) => {
    const prepared = prepare(statement.sql);
    const columns = prepared.columns();
    if (columns.length) return { rows: prepared.all(...statement.parameters), columns };
    const result = prepared.run(...statement.parameters);
    return { rows: [], columns, affectedRows: result.changes, insertId: result.lastInsertRowid };
  };
  const sqliteConn = sqliteConnection({ prepare, exec: (text) => sqlite.exec(text), close: () => sqlite.close() });
  cleanup[cleanup.length - 1] = () => sqliteConn.release();
  report.engines.sqlite = {
    version: sqlite.prepare("SELECT sqlite_version() AS version").get().version,
    rows: "array",
    integers: "bigint before string projection",
    acquisition: "not applicable: node:sqlite has no provider/pool",
  };
  await runEngine("sqlite", nativeSqlite, sqliteConn, baselineSqlite(sqlite), createNodeSqliteDatabase(sqlite));
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const close of cleanup.toReversed()) {
    try {
      await close();
    } catch (error) {
      (report.cleanupErrors ??= []).push(String(error));
      process.exitCode = 1;
      report.status = "failed";
    }
  }
  await new Promise((done) => setImmediate(done));
  observer.disconnect();
  for (const entry of report.cases)
    for (const variant of Object.values(entry.variants))
      for (const sample of variant.samples) {
        const events = gcEvents.filter((event) => event.startMs >= sample.startMs && event.startMs < sample.endMs);
        sample.gc = { count: events.length, durationMs: events.reduce((sum, event) => sum + event.durationMs, 0) };
      }
  report.gcEvents = gcEvents;
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(output);
}
