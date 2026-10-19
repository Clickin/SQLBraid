import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import QueryStream from "pg-query-stream";
import Cursor from "pg-cursor";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { representationProfiles, sql as braidSql } from "@sqlbraid/postgres";
import { defineEntity, sql as uqlSql } from "uql-orm";
import { PgQuerierPool } from "uql-orm/postgres";
import { Kysely, PostgresDialect, sql as kyselySql } from "kysely";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql as drizzleSql, eq, lte, asc } from "drizzle-orm";
import * as pgCore from "drizzle-orm/pg-core";

const TABLE = "sqlbraid_perf_rows";
const WRITE_TABLE = "sqlbraid_perf_writes";
const POOL_SIZE = 4;
const STREAM_BATCH_SIZE = 100;
const columns = [
  "id",
  "name",
  ...Array.from({ length: 22 }, (_, i) => `c${String(i + 3).padStart(2, "0")}`),
  "nullable",
  "amount",
  "big",
  "day",
  "at",
  "payload",
  "active",
];
const mixedColumns = ["id", "name", "c03", "nullable", "amount", "big", "day", "at", "payload", "active"];
const nativeProfile = representationProfiles.find((entry) => entry.id === "pg-native");
assert.ok(nativeProfile, "pg-native representation profile must be available");

// oxlint-disable-next-line typescript/no-extraneous-class -- UQL registers entities by class identity.
class PerfRow {}
defineEntity(PerfRow, {
  name: TABLE,
  fields: Object.fromEntries(
    columns.map((name) => [
      name,
      {
        type:
          name === "id" || /^c\d+$/u.test(name)
            ? Number
            : name === "day" || name === "at"
              ? Date
              : name === "payload"
                ? Object
                : name === "active"
                  ? Boolean
                  : String,
        ...(name === "id" ? { isId: true } : {}),
      },
    ]),
  ),
});
const table = pgCore.pgTable(
  TABLE,
  Object.fromEntries(
    columns.map((name) => [
      name,
      name === "id" || /^c\d+$/u.test(name)
        ? pgCore.integer(name)
        : name === "amount"
          ? pgCore.numeric(name)
          : name === "day"
            ? pgCore.date(name, { mode: "date" })
            : name === "at"
              ? pgCore.timestamp(name, { mode: "date", withTimezone: true })
              : name === "payload"
                ? pgCore.jsonb(name)
                : name === "active"
                  ? pgCore.boolean(name)
                  : pgCore.text(name),
    ]),
  ),
);

const many = async (fn) => {
  const result = [];
  for (let i = 0; i < 10; i++) result.push(await fn());
  return result;
};
const consume = async (iterable, collect = false) => {
  if (collect) {
    const rows = [];
    for await (const row of iterable) rows.push(row);
    return rows;
  }
  let count = 0;
  let checksum = 0;
  for await (const row of iterable) {
    count++;
    checksum += row.id;
  }
  return { count, checksum };
};
const commands = (implementation, target) => async (shape, values) => {
  if (implementation === "pg") return (await target.query(shape.text, values)).rowCount;
  if (implementation === "SQLBraid")
    return (await target.execute(braidSql.command(shape.template, ...values))).command.affectedRows;
  if (implementation === "UQL") return (await target.run(uqlSql(shape.template, ...values))).changes;
  if (implementation === "Kysely") {
    const result = await kyselySql(shape.template, ...values).execute(target);
    return Number(result.numAffectedRows);
  }
  return (await target.execute(drizzleSql(shape.template, ...values))).rowCount;
};
// A fixed template is created once per SQL shape, not once per measured operation.
function template(text) {
  const parts = text.split(/\$\d+/u);
  Object.defineProperty(parts, "raw", { value: Object.freeze([...parts]) });
  return Object.freeze(parts);
}
function statement(text) {
  return { text, template: template(text) };
}
function nativeRowsSchema(transform) {
  return {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-performance",
      validate(row) {
        if (
          !row ||
          !Number.isInteger(row.id) ||
          typeof row.name !== "string" ||
          !Number.isInteger(row.c03) ||
          typeof row.active !== "boolean" ||
          !(row.nullable === null || typeof row.nullable === "string") ||
          !(row.amount === null || (typeof row.amount === "string" && /^\d+\.\d{6}$/u.test(row.amount))) ||
          typeof row.big !== "string" ||
          !/^\d+$/u.test(row.big) ||
          !(row.day === null || (row.day instanceof Date && Number.isFinite(row.day.getTime()))) ||
          !(row.at === null || (row.at instanceof Date && Number.isFinite(row.at.getTime()))) ||
          !row.payload ||
          row.payload.id !== row.id ||
          typeof row.payload.active !== "boolean" ||
          !Array.isArray(row.payload.tags)
        ) {
          return { issues: [{ message: "Unexpected native PostgreSQL value representation" }] };
        }
        return {
          value: transform
            ? {
                ...row,
                big: BigInt(row.big),
                day: row.day === null ? null : row.day.toISOString().slice(0, 10),
                at: row.at === null ? null : row.at.toISOString(),
              }
            : row,
        };
      },
    },
  };
}

export async function createSuite({ connectionString, profile = "full" } = {}) {
  connectionString ??= "postgres://sqlbraid_perf:sqlbraid_perf@127.0.0.1:55432/sqlbraid_perf";
  const url = new URL(connectionString);
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    "sqlbraid_perf",
    "Refusing fixture setup outside sqlbraid_perf",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Benchmark database must be local and dedicated",
  );
  // pg DATE parsing uses the process zone; all participants must see the same midnight.
  process.env.TZ = "UTC";
  const config = {
    connectionString,
    max: POOL_SIZE,
    min: POOL_SIZE,
    keepAlive: true,
    idleTimeoutMillis: 0,
    options: "-c timezone=UTC",
    types: pg.types,
  };
  const direct = new pg.Client(config);
  await direct.connect();
  const lock = await direct.query("SELECT pg_try_advisory_lock(184621, 200) AS locked");
  if (!lock.rows[0].locked) {
    await direct.end();
    throw new Error("Another benchmark process owns sqlbraid_perf");
  }
  const pool = new pg.Pool(config);
  // UQL creates its own pg.Pool. Passing types overrides its per-pool wireTypes defaults.
  const uql = new PgQuerierPool(config);
  const braid = createPgPoolDatabase(pool, { profile: nativeProfile, streamBatchSize: STREAM_BATCH_SIZE });
  const braidDirect = createPgDatabase(direct, { profile: nativeProfile, streamBatchSize: STREAM_BATCH_SIZE });
  const braidDefault = createPgPoolDatabase(pool);
  const kysely = new Kysely({ dialect: new PostgresDialect({ pool, cursor: Cursor }) });
  const drizzleDb = drizzle(pool);
  const cases = [];
  const metadata = {
    database: "sqlbraid_perf",
    poolSize: POOL_SIZE,
    streamBatchSize: STREAM_BATCH_SIZE,
    profile,
    driver: "pg",
    representation: "pg-native; exact numeric/int8 text; UTC Date; parsed JSON",
    fixtureRows: 10000,
    sources: [
      "https://www.uql-orm.dev/postgres",
      "https://unpkg.com/uql-orm@0.102.6/dist/postgres/pgQuerierPool.js",
      "https://unpkg.com/uql-orm@0.102.6/dist/postgres/pgWireTypes.js",
      "https://unpkg.com/uql-orm@0.102.6/dist/dialect/hydrateColumn.js",
      "https://unpkg.com/uql-orm@0.102.6/dist/entity/metadata/definition.d.ts",
      "https://unpkg.com/drizzle-orm@0.45.4/node-postgres/session.js",
      "https://unpkg.com/kysely@0.29.7/dist/dialect/postgres/postgres-dialect-config.d.ts",
      "https://node-postgres.com/features/types",
      "https://node-postgres.com/features/queries",
    ],
    fairness: [
      "Same pg version, local server, max/min 4 pool configuration, keepAlive and UTC timezone.",
      "pg/SQLBraid/Kysely/Drizzle share one pool; UQL owns a separate identically configured pool.",
      "UQL 0.102.6 normally decodes int8 and zoneless temporal values per pool, never globally; explicit pg.types overrides these defaults.",
      "UQL entity numeric and bigint columns are declared String to preserve exact pg-native text rather than Number/BigInt hydration.",
      "Logical reads use natural query builders and their generated SQL; UQL hydration and Drizzle array-row mapping remain included.",
      "SQLBraid pg-native retains exact integers as text. Logical projections explicitly cast int4 columns to float8; every int32 is exactly representable. Equivalent SQL applies the same casts to all participants.",
      "No custom SQLBraid TypePolicy. Separate default-lossless cases leave its default parser profile untouched.",
      "Fixture timestamps have microseconds. Native Date cases intentionally have millisecond precision; default-lossless and equivalent-text cases retain all six fractional digits and are not pooled with native scores.",
      "Equivalent SQL casts date and timestamptz to text for every participant: Drizzle raw execution overrides temporal parsers, even when the pool supplies pg.types.",
      "Equivalent SQL uses each library raw-SQL API; it does not claim to measure ORM entity hydration.",
      "Parameters and SQL generation are included in each operation; templates and expected values are prepared outside steady-state timing.",
      "Driver-call capture is installed only during verification; setup, reference queries and per-round write resets are excluded. Timed restoring commands remain counted.",
      "Startup cases include construction, connect/first query and close, but exclude module import and server startup.",
      "Named prepared handles are tested only where exposed by the public API (pg, SQLBraid, Drizzle); no fake prepared path for UQL or Kysely.",
      "Drizzle node-postgres does not expose a cursor stream or nontransactional pinned-session callback; those cells are not emulated.",
    ],
  };
  const close = async () => {
    await Promise.all([pool.end(), uql.end(), direct.end()]);
  };
  try {
    await direct.query(await readFile(new URL("./fixture.sql", import.meta.url), "utf8"));
    metadata.server = (
      await direct.query("SELECT version() AS version, current_setting('TimeZone') AS timezone")
    ).rows[0];
    // Establish all physical connections before steady-state measurements.
    for (const target of [pool, uql.pool]) {
      const clients = await Promise.all(Array.from({ length: POOL_SIZE }, () => target.connect()));
      await Promise.all(clients.map((client) => client.query("SELECT 1")));
      clients.forEach((client) => client.release());
    }

    function add({
      name,
      group,
      implementation,
      category,
      run,
      verifyRun = run,
      expected,
      check,
      before,
      after,
      ...details
    }) {
      const caseMetadata = { logicalOperationsPerInvocation: 1, ...details };
      cases.push({
        name,
        group,
        implementation,
        category,
        async: true,
        run,
        before,
        after,
        metadata: caseMetadata,
        async verify() {
          const calls = [];
          const original = pg.Client.prototype.query;
          pg.Client.prototype.query = function (query, values, ...rest) {
            const text = typeof query === "string" ? query : query?.text;
            calls.push({
              sql: text ?? "[cursor]",
              parameters:
                typeof query === "string"
                  ? Array.isArray(values)
                    ? values
                    : []
                  : (query?.values ?? (Array.isArray(values) ? values : [])),
              preparedName: typeof query === "object" ? query?.name : undefined,
              rowMode: typeof query === "object" ? query?.rowMode : undefined,
            });
            return original.call(this, query, values, ...rest);
          };
          let actual;
          try {
            actual = await verifyRun();
          } finally {
            pg.Client.prototype.query = original;
          }
          caseMetadata.driverCallsPerInvocation = calls.length;
          caseMetadata.generatedSql = calls;
          if (check) await check(actual);
          else assert.deepStrictEqual(actual, expected, `${name}: row values or representations differ`);
        },
      });
    }
    function rawRuns(shape, values) {
      return {
        pg: async () => (await pool.query(shape.text, values())).rows,
        SQLBraid: () => braid.all(braidSql.rows(shape.template, ...values())),
        UQL: () => uql.all(uqlSql(shape.template, ...values())),
        Kysely: async () => (await kyselySql(shape.template, ...values()).execute(kysely)).rows,
        Drizzle: async () => (await drizzleDb.execute(drizzleSql(shape.template, ...values()))).rows,
      };
    }
    async function readCases(selected, rowCount, indexed = false) {
      const label = `${indexed ? "indexed" : "rows"}-${rowCount}-${selected.length}cols${selected === mixedColumns ? "-mixed" : ""}`;
      const where = indexed ? "id = $1" : "id <= $1";
      const shape = statement(`SELECT ${selected.join(", ")} FROM ${TABLE} WHERE ${where} ORDER BY id`);
      const nativeProjection = selected.map((key) =>
        key === "id" || /^c\d+$/u.test(key) ? `${key}::float8 AS ${key}` : key,
      );
      const braidShape = statement(`SELECT ${nativeProjection.join(", ")} FROM ${TABLE} WHERE ${where} ORDER BY id`);
      const expected = (await direct.query(shape.text, [rowCount])).rows;
      const selection = Object.fromEntries(selected.map((key) => [key, true]));
      const drizzleSelection = Object.fromEntries(selected.map((key) => [key, table[key]]));
      const logical = {
        pg: () => pool.query(shape.text, [rowCount]).then((r) => r.rows),
        SQLBraid: () => braid.all(braidSql.rows(braidShape.template, rowCount)),
        UQL: () =>
          uql.findMany(PerfRow, {
            $select: selection,
            $where: { id: indexed ? rowCount : { $lte: rowCount } },
            $sort: { id: 1 },
          }),
        Kysely: () =>
          kysely
            .selectFrom(TABLE)
            .select(selected)
            .where("id", indexed ? "=" : "<=", rowCount)
            .orderBy("id")
            .execute(),
        Drizzle: () =>
          drizzleDb
            .select(drizzleSelection)
            .from(table)
            .where(indexed ? eq(table.id, rowCount) : lte(table.id, rowCount))
            .orderBy(asc(table.id)),
      };
      for (const [implementation, run] of Object.entries(logical)) {
        add({
          name: `postgres/logical/${label}/${implementation}`,
          group: label,
          implementation,
          category: "logical",
          run,
          expected,
        });
      }
      const portable = selected.map((key) =>
        key === "day" || key === "at"
          ? `${key}::text AS ${key}`
          : key === "id" || /^c\d+$/u.test(key)
            ? `${key}::float8 AS ${key}`
            : key,
      );
      const equivalent = statement(`SELECT ${portable.join(", ")} FROM ${TABLE} WHERE ${where} ORDER BY id`);
      const equivalentExpected = (await direct.query(equivalent.text, [rowCount])).rows;
      for (const [implementation, run] of Object.entries(rawRuns(equivalent, () => [rowCount]))) {
        add({
          name: `postgres/equivalent-sql/${label}/${implementation}`,
          group: label,
          implementation,
          category: "equivalent-sql",
          run,
          expected: equivalentExpected,
          temporalRepresentation: "explicit text casts",
        });
      }
    }
    await readCases(columns.slice(0, 2), 1, true);
    await readCases(columns.slice(0, 10), 1, true);
    for (const count of [10, 100, 1000, 10000]) {
      for (const selected of [columns.slice(0, 2), columns, mixedColumns]) await readCases(selected, count);
    }

    for (const count of [1, 10, 50]) {
      const shape = statement(
        `SELECT id::float8 AS id, name FROM ${TABLE} WHERE id IN (${Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ")}) ORDER BY id`,
      );
      for (const implementation of ["pg", "SQLBraid", "UQL", "Kysely", "Drizzle"]) {
        let iteration = 0;
        let lastValues;
        const values = () => {
          const start = (iteration++ % 100) * 50 + 1;
          lastValues = Array.from({ length: count }, (_, i) => start + i);
          return lastValues;
        };
        add({
          name: `postgres/parameters/${count}/${implementation}`,
          group: `parameters-${count}`,
          implementation,
          category: "equivalent-sql",
          run: rawRuns(shape, values)[implementation],
          parameters: count,
          varyingValues: true,
          check: async (actual) => assert.deepStrictEqual(actual, (await direct.query(shape.text, lastValues)).rows),
        });
      }
    }

    const one = statement(`SELECT id::float8 AS id, name FROM ${TABLE} WHERE id = $1 ORDER BY id`);
    const oneExpected = (await direct.query(one.text, [1])).rows;
    const tenExpected = Array.from({ length: 10 }, () => oneExpected);
    const lifecycle = (label, implementation, run, expected = oneExpected, operations = 1) =>
      add({
        name: `postgres/lifecycle/${label}/${implementation}`,
        group: `lifecycle-${label}`,
        implementation,
        category: "lifecycle",
        run,
        expected,
        logicalOperationsPerInvocation: operations,
      });
    lifecycle("direct", "pg", async () => (await direct.query(one.text, [1])).rows);
    lifecycle("direct", "SQLBraid", () => braidDirect.all(braidSql.rows(one.template, 1)));
    for (const [implementation, run] of Object.entries(rawRuns(one, () => [1]))) {
      lifecycle("pool", implementation, run);
      lifecycle("pool-ten", implementation, () => many(run), tenExpected, 10);
      lifecycle(
        "concurrency-4",
        implementation,
        () => Promise.all(Array.from({ length: POOL_SIZE }, run)),
        Array.from({ length: POOL_SIZE }, () => oneExpected),
        POOL_SIZE,
      );
    }
    const rawPinned = async (transaction) => {
      const client = await pool.connect();
      try {
        if (transaction) await client.query("BEGIN");
        const rows = await many(async () => (await client.query(one.text, [1])).rows);
        if (transaction) await client.query("COMMIT");
        return rows;
      } catch (error) {
        if (transaction) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    lifecycle("pinned-session", "pg", () => rawPinned(false), tenExpected, 10);
    lifecycle(
      "pinned-session",
      "SQLBraid",
      () => braid.session((session) => many(() => session.all(braidSql.rows(one.template, 1)))),
      tenExpected,
      10,
    );
    lifecycle(
      "pinned-session",
      "UQL",
      () => uql.withQuerier((q) => many(() => q.all(uqlSql(one.template, 1)))),
      tenExpected,
      10,
    );
    lifecycle(
      "pinned-session",
      "Kysely",
      () => kysely.connection().execute((db) => many(async () => (await kyselySql(one.template, 1).execute(db)).rows)),
      tenExpected,
      10,
    );
    lifecycle("transaction", "pg", () => rawPinned(true), tenExpected, 10);
    lifecycle(
      "transaction",
      "SQLBraid",
      () => braid.tx((tx) => many(() => tx.all(braidSql.rows(one.template, 1)))),
      tenExpected,
      10,
    );
    lifecycle(
      "transaction",
      "UQL",
      () => uql.transaction((q) => many(() => q.all(uqlSql(one.template, 1)))),
      tenExpected,
      10,
    );
    lifecycle(
      "transaction",
      "Kysely",
      () => kysely.transaction().execute((tx) => many(async () => (await kyselySql(one.template, 1).execute(tx)).rows)),
      tenExpected,
      10,
    );
    lifecycle(
      "transaction",
      "Drizzle",
      () => drizzleDb.transaction((tx) => many(async () => (await tx.execute(drizzleSql(one.template, 1))).rows)),
      tenExpected,
      10,
    );
    const prepared = braid.prepare("perf-by-id", (id) => braidSql.rows(one.template, id));
    lifecycle(
      "prepared",
      "pg",
      async () => (await pool.query({ name: "perf-raw-by-id", text: one.text, values: [1] })).rows,
    );
    lifecycle("prepared", "SQLBraid", () => prepared.all(1));
    const drizzlePrepared = drizzleDb
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(eq(table.id, drizzleSql.placeholder("id")))
      .orderBy(asc(table.id))
      .prepare("perf-drizzle-by-id");
    lifecycle("prepared", "Drizzle", () => drizzlePrepared.execute({ id: 1 }));
    lifecycle("batch", "pg", () => rawPinned(false), tenExpected, 10);
    lifecycle(
      "batch",
      "SQLBraid",
      async () =>
        (await braid.batch(Array.from({ length: 10 }, () => braidSql.rows(one.template, 1)))).map(
          (result) => result.rows,
        ),
      tenExpected,
      10,
    );

    const resultProjection = mixedColumns.map((key) =>
      key === "id" || key === "c03" ? `${key}::float8 AS ${key}` : key,
    );
    const resultShape = statement(`SELECT ${resultProjection.join(", ")} FROM ${TABLE} WHERE id <= $1 ORDER BY id`);
    const defaultShape = statement(`SELECT ${mixedColumns.join(", ")} FROM ${TABLE} WHERE id <= $1 ORDER BY id`);
    const losslessOids = new Set([20, 21, 23, 26, 1700, 114, 3802, 1082, 1114, 1184]);
    const losslessTypes = {
      getTypeParser: (oid, format) =>
        losslessOids.has(oid) && format !== "binary" ? (value) => value : pg.types.getTypeParser(oid, format),
    };
    for (const count of [0, 1, 10, 100, 1000, 10000]) {
      const defaultExpected = (await direct.query({ text: defaultShape.text, values: [count], types: losslessTypes }))
        .rows;
      for (const implementation of ["pg", "SQLBraid"])
        add({
          name: `postgres/results/default-lossless-${count}/${implementation}`,
          group: `default-lossless-${count}`,
          implementation,
          category: "logical",
          expected: defaultExpected,
          run:
            implementation === "SQLBraid"
              ? () => braidDefault.all(braidSql.rows(defaultShape.template, count))
              : async () => (await pool.query({ text: defaultShape.text, values: [count], types: losslessTypes })).rows,
          representation: "Unchanged SQLBraid default pg-lossless-text; pg explicitly uses matching text parsers",
        });
      const expected = (await direct.query(resultShape.text, [count])).rows;
      const validation = nativeRowsSchema(false);
      const transform = nativeRowsSchema(true);
      add({
        name: `postgres/results/native-${count}/pg`,
        group: `results-${count}`,
        implementation: "pg",
        category: "logical",
        run: async () => (await pool.query(resultShape.text, [count])).rows,
        expected,
      });
      add({
        name: `postgres/results/no-schema-${count}/SQLBraid`,
        group: `results-${count}`,
        implementation: "SQLBraid",
        category: "logical",
        run: () => braid.all(braidSql.rows(resultShape.template, count)),
        expected,
      });
      for (const [mode, schema] of [
        ["validate", validation],
        ["transform", transform],
      ]) {
        const mapped = expected.map((row) => schema["~standard"].validate(row).value);
        assert.ok(
          mapped.every((row) => row !== undefined),
          "Fixture must satisfy native schema",
        );
        add({
          name: `postgres/results/${mode}-${count}/SQLBraid`,
          group: `results-${count}`,
          implementation: "SQLBraid",
          category: "logical",
          run: () => braid.all(braidSql.rows(schema)(resultShape.template, count)),
          expected: mapped,
          schema: mode,
          transformSemantics:
            mode === "transform"
              ? "int8 to BigInt; dates to ISO; numeric remains exact text; null preserved"
              : undefined,
        });
        add({
          name: `postgres/results/${mode}-${count}/pg`,
          group: `results-${count}`,
          implementation: "pg",
          category: "logical",
          run: async () =>
            (await pool.query(resultShape.text, [count])).rows.map((row) => {
              const result = schema["~standard"].validate(row);
              if (result.issues) throw new Error(result.issues[0].message);
              return result.value;
            }),
          expected: mapped,
          schema: mode,
        });
      }
    }

    const streamShape = statement(`SELECT id::float8 AS id, name FROM ${TABLE} WHERE id <= $1 ORDER BY id`);
    for (const count of [100, 10000]) {
      const expected = (await direct.query(streamShape.text, [count])).rows;
      const runs = {
        pg: async (collect = false) => {
          const client = await pool.connect();
          try {
            return await consume(
              client.query(new QueryStream(streamShape.text, [count], { batchSize: STREAM_BATCH_SIZE })),
              collect,
            );
          } finally {
            client.release();
          }
        },
        SQLBraid: (collect = false) => consume(braid.stream(braidSql.rows(streamShape.template, count)), collect),
        UQL: (collect = false) =>
          consume(
            uql.findManyStream(PerfRow, {
              $select: { id: true, name: true },
              $where: { id: { $lte: count } },
              $sort: { id: 1 },
            }),
            collect,
          ),
        Kysely: (collect = false) =>
          consume(
            kysely
              .selectFrom(TABLE)
              .select(["id", "name"])
              .where("id", "<=", count)
              .orderBy("id")
              .stream(STREAM_BATCH_SIZE),
            collect,
          ),
      };
      for (const [implementation, run] of Object.entries(runs))
        add({
          name: `postgres/streaming/${count}/${implementation}`,
          group: `streaming-${count}`,
          implementation,
          category: "streaming",
          run,
          verifyRun: () => run(true),
          expected,
          fairness:
            implementation === "UQL"
              ? "Natural hydrated entity stream; pg-query-stream default batch size 100"
              : "Cursor fetch size 100",
        });
    }

    // Every invocation restores its own rows, bounding storage even in long throughput runs.
    const writeSpecs = {
      insert: [
        statement(`INSERT INTO ${WRITE_TABLE} (id, value) VALUES ($1, $2)`),
        statement(`DELETE FROM ${WRITE_TABLE} WHERE id = $1`),
      ],
      update: [
        statement(`UPDATE ${WRITE_TABLE} SET value = $1 WHERE id = $2`),
        statement(`UPDATE ${WRITE_TABLE} SET value = $1 WHERE id = $2`),
      ],
      delete: [
        statement(`DELETE FROM ${WRITE_TABLE} WHERE id = $1`),
        statement(`INSERT INTO ${WRITE_TABLE} (id, value) VALUES ($1, $2)`),
      ],
    };
    const resetWrites = () => direct.query(`TRUNCATE TABLE ${WRITE_TABLE}; INSERT INTO ${WRITE_TABLE} VALUES (1, 0)`);
    const checkWrites = async (actual) => {
      assert.equal(actual, 2);
      assert.deepStrictEqual((await direct.query(`SELECT id, value FROM ${WRITE_TABLE} ORDER BY id`)).rows, [
        { id: 1, value: 0 },
      ]);
    };
    const targets = { pg: pool, SQLBraid: braid, UQL: uql, Kysely: kysely, Drizzle: drizzleDb };
    const inTransaction = async (implementation, fn) => {
      if (implementation === "SQLBraid") return braid.tx(fn);
      if (implementation === "UQL") return uql.transaction(fn);
      if (implementation === "Kysely") return kysely.transaction().execute(fn);
      if (implementation === "Drizzle") return drizzleDb.transaction(fn);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    for (const [operation, shapes] of Object.entries(writeSpecs)) {
      const values =
        operation === "insert"
          ? [[2, 1], [2]]
          : operation === "delete"
            ? [[1], [1, 0]]
            : [
                [1, 1],
                [0, 1],
              ];
      for (const [implementation, target] of Object.entries(targets)) {
        for (const grouped of [false, true]) {
          const runOn = async (db) => {
            const execute = commands(implementation, db);
            return (await execute(shapes[0], values[0])) + (await execute(shapes[1], values[1]));
          };
          add({
            name: `postgres/writes/${operation}-${grouped ? "transaction" : "autocommit"}/${implementation}`,
            group: `writes-${operation}`,
            implementation,
            category: "writes",
            run: () => (grouped ? inTransaction(implementation, runOn) : runOn(target)),
            before: resetWrites,
            check: checkWrites,
            logicalOperationsPerInvocation: 2,
            fairness:
              "Two commands: target mutation plus restoring inverse; both timed. Raw SQL paths, no generated-id readback.",
          });
        }
      }
    }
    const insertShape = statement(`INSERT INTO ${WRITE_TABLE} (id, value) VALUES ($1, $2)`);
    const clearShape = statement(`DELETE FROM ${WRITE_TABLE} WHERE id > $1`);
    const noResultShape = statement(`UPDATE ${WRITE_TABLE} SET value = $1 WHERE id = $2`);
    for (const [implementation, target] of Object.entries(targets)) {
      add({
        name: `postgres/writes/no-result/${implementation}`,
        group: "writes-no-result",
        implementation,
        category: "writes",
        run: () => commands(implementation, target)(noResultShape, [0, -1]),
        expected: 0,
      });
      for (const grouped of [false, true]) {
        const runOn = async (db) => {
          const execute = commands(implementation, db);
          let inserted = 0;
          if (implementation === "SQLBraid") {
            const result = await db.batch(
              Array.from({ length: 10 }, (_, i) => braidSql.command(insertShape.template, i + 2, i)),
            );
            inserted = result.reduce((sum, entry) => sum + entry.command.affectedRows, 0);
          } else {
            for (let i = 0; i < 10; i++) inserted += await execute(insertShape, [i + 2, i]);
          }
          const restored = await execute(clearShape, [1]);
          return { inserted, restored };
        };
        add({
          name: `postgres/writes/batch-insert-${grouped ? "transaction" : "autocommit"}/${implementation}`,
          group: "writes-batch-insert",
          implementation,
          category: "writes",
          run: () => (grouped ? inTransaction(implementation, runOn) : runOn(target)),
          before: resetWrites,
          logicalOperationsPerInvocation: 11,
          fairness:
            "Ten INSERT commands plus one timed restoring DELETE. SQLBraid batch pins one lease; other raw APIs execute sequentially.",
          check: async (actual) => {
            assert.deepEqual(actual, { inserted: 10, restored: 10 });
            await checkWrites(2);
          },
        });
      }
    }
    for (const implementation of ["pg", "SQLBraid", "UQL", "Kysely", "Drizzle"]) {
      add({
        name: `postgres/startup/initialize-connect-query-close/${implementation}`,
        group: "startup",
        implementation,
        category: "startup",
        expected: oneExpected,
        run: async () => {
          if (implementation === "UQL") {
            const instance = new PgQuerierPool(config);
            try {
              return await instance.all(uqlSql(one.template, 1));
            } finally {
              await instance.end();
            }
          }
          const fresh = new pg.Pool(config);
          try {
            if (implementation === "pg") return (await fresh.query(one.text, [1])).rows;
            if (implementation === "SQLBraid")
              return await createPgPoolDatabase(fresh, { profile: nativeProfile }).all(braidSql.rows(one.template, 1));
            if (implementation === "Kysely")
              return (
                await kyselySql(one.template, 1).execute(new Kysely({ dialect: new PostgresDialect({ pool: fresh }) }))
              ).rows;
            return (await drizzle(fresh).execute(drizzleSql(one.template, 1))).rows;
          } finally {
            await fresh.end();
          }
        },
        includes: ["library construction", "pool construction", "connection", "first query", "pool close"],
        excludes: ["module import", "server startup"],
      });
    }
    return { cases, metadata, close };
  } catch (error) {
    await close();
    throw error;
  }
}
