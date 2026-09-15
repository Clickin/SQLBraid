#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SQL } from "bun";
import { createBunSqlDatabase, representationProfileFor } from "@sqlbraid/bun-sql";
import { guarded } from "@sqlbraid/template";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as mariadb } from "@sqlbraid/mariadb";
import { sql as sqlite } from "@sqlbraid/sqlite";

const dialectTags = { postgres, mysql, mariadb, sqlite };
const envNames = {
  postgres: ["SQLBRAID_BUN_SQL_POSTGRES_URL", "SQLBRAID_POSTGRES_URL"],
  mysql: ["SQLBRAID_BUN_SQL_MYSQL_URL", "SQLBRAID_MYSQL_URL"],
  mariadb: ["SQLBRAID_BUN_SQL_MARIADB_URL", "SQLBRAID_MARIADB_URL", "MARIADB_URL"],
  sqlite: ["SQLBRAID_BUN_SQL_SQLITE_URL", "SQLBRAID_SQLITE_URL"],
};
const targetFiles = {
  postgres: "support/targets/postgres.json",
  mysql: "support/targets/mysql.json",
  mariadb: "support/targets/mariadb.json",
  sqlite: "support/targets/sqlite.json",
};

function configuredUrl(dialect) {
  for (const name of envNames[dialect]) if (process.env[name]) return process.env[name];
  return dialect === "sqlite" ? ":memory:" : undefined;
}

function connection(dialect, url) {
  if (dialect === "sqlite") {
    return new SQL({ adapter: "sqlite", filename: url ?? ":memory:", safeIntegers: true });
  }
  return new SQL(url, { bigint: true });
}

function castInteger(sqlTag, value) {
  if (sqlTag === postgres) return sqlTag`SELECT CAST(${value} AS TEXT) AS exact_integer`;
  if (sqlTag === mysql || sqlTag === mariadb) return sqlTag`SELECT CAST(${value} AS CHAR) AS exact_integer`;
  return sqlTag`SELECT CAST(${value} AS TEXT) AS exact_integer`;
}

function connectionId(sqlTag) {
  if (sqlTag === postgres) return sqlTag`SELECT CAST(pg_backend_pid() AS TEXT) AS connection_id`;
  if (sqlTag === mysql || sqlTag === mariadb) return sqlTag`SELECT CAST(CONNECTION_ID() AS CHAR) AS connection_id`;
  return sqlTag`SELECT 'direct' AS connection_id`;
}

function databaseVersion(sqlTag) {
  if (sqlTag === postgres) return sqlTag`SELECT version() AS version`;
  if (sqlTag === mysql || sqlTag === mariadb) return sqlTag`SELECT VERSION() AS version`;
  return sqlTag`SELECT sqlite_version() AS version`;
}

function normalizeDatabaseVersion(dialect, raw) {
  const text = String(raw);
  if (dialect === "postgres") {
    const match = /^PostgreSQL\s+(\d+(?:\.\d+){1,2})/u.exec(text);
    assert.ok(match, `Unable to parse PostgreSQL version probe: ${text}`);
    return { version: match[1], versionRaw: text };
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    const match = /^(\d+(?:\.\d+){2})/u.exec(text);
    assert.ok(match, `Unable to parse MySQL-family version probe: ${text}`);
    return { version: match[1], versionRaw: text };
  }
  return { version: text, versionRaw: text };
}

function sleepQuery(sqlTag) {
  if (sqlTag === postgres) return sqlTag`SELECT pg_sleep(10)`;
  if (sqlTag === mysql || sqlTag === mariadb) return sqlTag`SELECT SLEEP(10)`;
  return sqlTag`SELECT 1`;
}

async function readManifest(dialect) {
  try {
    return JSON.parse(await readFile(targetFiles[dialect], "utf8"));
  } catch {
    return undefined;
  }
}

async function runDialect(dialect) {
  const url = configuredUrl(dialect);
  if (url === undefined) throw new Error(`Missing Bun.SQL ${dialect} URL; set ${envNames[dialect][0]} or the existing SQLBraid URL variable.`);
  const sqlTag = dialectTags[dialect];
  const client = connection(dialect, url);
  const db = createBunSqlDatabase(client, { dialect });
  const environment = await db.environment();
  const versionRow = await db.one(databaseVersion(sqlTag));
  const observedVersion = normalizeDatabaseVersion(dialect, versionRow.version);
  const manifest = await readManifest(dialect);
  if (manifest?.database?.version && dialect !== "sqlite") assert.equal(observedVersion.version, manifest.database.version);

  const sessionIds = await db.session(async (session) => {
    const first = await session.one(connectionId(sqlTag));
    const second = await session.one(connectionId(sqlTag));
    assert.equal(first.connection_id, second.connection_id, `${dialect} session lost physical connection affinity`);
    return [first.connection_id, second.connection_id];
  });

  const prepared = db.prepare("bun-sql-matrix-cast", (value) => castInteger(sqlTag, value));
  const preparedInput = dialect === "mysql" || dialect === "mariadb" ? "9007199254740993" : 9007199254740993n;
  const preparedRow = await prepared.one(preparedInput);
  assert.equal(preparedRow.exact_integer, "9007199254740993");
  const mappedSchema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-bun-sql-matrix",
      validate(value) {
        assert.equal(value.schema_value, "mapped");
        return { value: value.schema_value.toUpperCase() };
      },
    },
  };
  const schemaRow = await db.one(sqlTag.rows(mappedSchema)`SELECT ${"mapped"} AS schema_value`);
  assert.equal(schemaRow, "MAPPED");
  const nativeValues = await db.one(sqlTag.rows`
    SELECT ${"O'Reilly"} AS quoted_value,
           ${"DROP TABLE braid_bun_sql_matrix_bulk"} AS sql_looking_value,
           ${null} AS null_value
  `);
  assert.deepEqual(nativeValues, {
    quoted_value: "O'Reilly",
    sql_looking_value: "DROP TABLE braid_bun_sql_matrix_bulk",
    null_value: null,
  });
  const bunHelper = client({ value: "not a SQLBraid value" });
  await assert.rejects(
    db.one(sqlTag.rows`SELECT ${bunHelper}`),
    /Bun\.SQL structural helper/u,
  );
  const bunFragment = client`AND 1 = ${1}`;
  await assert.rejects(
    db.one(sqlTag.rows`SELECT 1 ${bunFragment}`),
    /Bun\.SQL query or fragment/u,
  );
  await assert.rejects(
    db.one(sqlTag.rows`SELECT ${ { json: true } }`),
    /ambiguous Bun\.SQL object value/u,
  );
  const inactive = guarded(
    sqlTag.rows,
    ["SELECT ", " AS value /*@braid if ", "*/ AND 1 = ", " /*@braid end*/"],
    [() => "1", () => false, () => { throw new Error("inactive Bun branch evaluated"); }],
  );
  assert.deepEqual(await db.one(inactive), { value: "1" });
  const where = guarded(
    sqlTag.rows,
    ["SELECT ", " AS value /*@braid where*/ /*@braid if ", "*/ AND ", " = ", " /*@braid end*/ /*@braid end*/"],
    [() => "1", () => true, () => "1", () => "1"],
  );
  assert.deepEqual(await db.one(where), { value: "1" });

  const bulkTable = "braid_bun_sql_matrix_bulk";
  if (dialect === "mysql" || dialect === "mariadb") {
    await client.unsafe(`CREATE TABLE ${bulkTable} (value TEXT)`, []);
  } else {
    await db.execute(sqlTag.command`CREATE TABLE ${sqlTag.raw(bulkTable)} (value TEXT)`);
  }
  const transactionWork = async (tx) => {
    await tx.execute(sqlTag.command`INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${"ok"})`);
    await tx.tx(async (nested) => {
      await nested.execute(sqlTag.command`INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${"nested"})`);
    });
    const rollback = new Error("rollback nested Bun transaction");
    await assert.rejects(tx.tx(async (nested) => {
      await nested.execute(sqlTag.command`INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${"rolled-back"})`);
      throw rollback;
    }), (error) => error === rollback);
    return tx.all(sqlTag.rows`SELECT value FROM ${sqlTag.raw(bulkTable)} ORDER BY value`);
  };
  const transactionResult = dialect === "sqlite"
    ? await db.tx(transactionWork)
    : await db.tx({ isolation: "serializable" }, transactionWork);
  assert.deepEqual(transactionResult.map((row) => row.value), ["nested", "ok"]);

  const bulkResult = await db.bulk(["bulk-a", "bulk-b"], (value) =>
    sqlTag.command`INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${value})`,
  );
  assert.equal(bulkResult.inputCount, 2);
  assert.equal(bulkResult.affectedRows, 2);
  const preparedCommand = db.prepare(
    "bun-sql-matrix-prepared-command",
    (value) => sqlTag.command`INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${value})`,
  );
  const preparedCommandResult = await preparedCommand.execute("prepared");
  assert.equal(preparedCommandResult.kind, "command");
  const resultCarriers = {
    emptySelectRows: undefined,
    zeroDmlAffectedRows: undefined,
  };
  try {
    const emptySelect = await db.all(sqlTag.rows`SELECT value FROM ${sqlTag.raw(bulkTable)} WHERE 1 = 0`);
    assert.deepEqual(emptySelect, []);
    resultCarriers.emptySelectRows = emptySelect.length;
  } catch (error) {
    assert.equal(error?.code, "BRAID_RESULT_KIND_AMBIGUOUS");
    resultCarriers.emptySelectRows = "ambiguous";
  }
  try {
    const zeroDml = await db.execute(sqlTag.command`UPDATE ${sqlTag.raw(bulkTable)} SET value = ${"zero"} WHERE 1 = 0`);
    assert.equal(zeroDml.command?.affectedRows, 0);
    resultCarriers.zeroDmlAffectedRows = zeroDml.command.affectedRows;
  } catch (error) {
    assert.equal(error?.code, "BRAID_RESULT_KIND_AMBIGUOUS");
    resultCarriers.zeroDmlAffectedRows = "ambiguous";
  }
  if (dialect === "postgres" || dialect === "sqlite") {
    const returningRows = await db.all(sqlTag.rows`
      INSERT INTO ${sqlTag.raw(bulkTable)} (value) VALUES (${"returning"}) RETURNING value
    `);
    assert.deepEqual(returningRows, [{ value: "returning" }]);
    resultCarriers.returningRows = returningRows.length;
  }
  const transactionModes = {};
  const isolationLevels = ["read-uncommitted", "read-committed", "repeatable-read", "serializable"];
  if (dialect === "postgres") {
    for (const isolation of isolationLevels) {
      await db.tx({ isolation }, async (tx) => {
        const row = await tx.one(sqlTag.rows`
          SELECT current_setting('transaction_isolation') AS actual_isolation,
                 current_setting('transaction_read_only') AS actual_read_only
        `);
        assert.equal(row.actual_isolation, isolation.replaceAll("-", " "));
        transactionModes[isolation] = row;
      });
    }
    for (const readOnly of [false, true]) {
      await db.tx({ readOnly }, async (tx) => {
        const row = await tx.one(sqlTag.rows`SELECT current_setting('transaction_read_only') AS actual_read_only`);
        assert.equal(row.actual_read_only, readOnly ? "on" : "off");
        transactionModes[`read-only-${readOnly}`] = row;
      });
    }
  } else if (dialect === "sqlite") {
    await db.tx({ isolation: "serializable" }, async (tx) => {
      assert.deepEqual(await tx.one(sqlTag.rows`SELECT value FROM ${sqlTag.raw(bulkTable)} WHERE value = ${"ok"}`), { value: "ok" });
    });
    transactionModes.serializable = "native transaction";
    for (const isolation of isolationLevels.filter((level) => level !== "serializable")) {
      await assert.rejects(db.tx({ isolation }, async () => undefined),
        (error) => error.code === "BRAID_TX_OPTION_UNSUPPORTED" && error.feature === `transaction.isolation.${isolation}`);
    }
    await assert.rejects(db.tx({ readOnly: true }, async () => undefined),
      (error) => error.code === "BRAID_TX_OPTION_UNSUPPORTED" && error.feature === "transaction.read-only");
  } else {
    const isolationTable = "braid_bun_sql_matrix_isolation";
    const writer = await client.reserve();
    try {
      await writer.unsafe(`CREATE TABLE ${isolationTable} (id INT PRIMARY KEY, value VARCHAR(32) NOT NULL)`, []);
      await writer.unsafe(`INSERT INTO ${isolationTable} VALUES (1, 'base')`, []);
      for (const [isolation, dirtyVisible] of [
        ["read-uncommitted", true],
        ["read-committed", false],
        ["repeatable-read", false],
      ]) {
        await writer.unsafe("START TRANSACTION", []);
        await writer.unsafe(`UPDATE ${isolationTable} SET value = 'dirty' WHERE id = 1`, []);
        await db.tx({ isolation }, async (tx) => {
          const row = await tx.one(sqlTag.rows`SELECT value FROM ${sqlTag.raw(isolationTable)} WHERE id = ${1}`);
          assert.equal(row.value, dirtyVisible ? "dirty" : "base");
          transactionModes[isolation] = { dirtyVisible };
        });
        await writer.unsafe("ROLLBACK", []);
      }
      for (const [isolation, seesCommit] of [["read-committed", true], ["repeatable-read", false]]) {
        await writer.unsafe(`UPDATE ${isolationTable} SET value = 'base' WHERE id = 1`, []);
        await db.tx({ isolation }, async (tx) => {
          const before = await tx.one(sqlTag.rows`SELECT value FROM ${sqlTag.raw(isolationTable)} WHERE id = ${1}`);
          assert.equal(before.value, "base");
          await writer.unsafe(`UPDATE ${isolationTable} SET value = 'committed' WHERE id = 1`, []);
          const after = await tx.one(sqlTag.rows`SELECT value FROM ${sqlTag.raw(isolationTable)} WHERE id = ${1}`);
          assert.equal(after.value, seesCommit ? "committed" : "base");
          transactionModes[isolation].seesCommit = seesCommit;
        });
      }
      await writer.unsafe("SET SESSION innodb_lock_wait_timeout = 1", []);
      await db.tx({ isolation: "serializable" }, async (tx) => {
        await tx.one(sqlTag.rows`SELECT value FROM ${sqlTag.raw(isolationTable)} WHERE id = ${1}`);
        await assert.rejects(writer.unsafe(`UPDATE ${isolationTable} SET value = 'blocked' WHERE id = 1`, []),
          (error) => error.errno === 1205);
      });
      transactionModes.serializable = { writerLockTimeout: true };
      await db.tx({ readOnly: true }, async (tx) => {
        await assert.rejects(tx.execute(sqlTag.command`INSERT INTO ${sqlTag.raw(isolationTable)} VALUES (${2}, ${"read-only"})`),
          (error) => error.errno === 1792);
      });
      await db.tx({ readOnly: false }, async (tx) => {
        const result = await tx.execute(sqlTag.command`INSERT INTO ${sqlTag.raw(isolationTable)} VALUES (${2}, ${"read-write"})`);
        assert.equal(result.command.affectedRows, 1);
      });
      transactionModes.readOnly = { writeRejected: true, readWriteAccepted: true };
    } finally {
      await writer.unsafe("ROLLBACK", []).catch(() => undefined);
      await writer.unsafe(`DROP TABLE IF EXISTS ${isolationTable}`, []);
      await writer.release();
    }
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    await client.unsafe(`DROP TABLE ${bulkTable}`, []);
  } else {
    await db.execute(sqlTag.command`DROP TABLE ${sqlTag.raw(bulkTable)}`);
  }

  const exactInteger = await db.one(sqlTag.rows`
    SELECT CAST(9007199254740993 AS ${dialect === "postgres" ? sqlTag.raw("BIGINT") : dialect === "sqlite" ? sqlTag.raw("INTEGER") : sqlTag.raw("SIGNED")}) AS exact_integer
  `);
  const approximate = await db.one(sqlTag.rows`
    SELECT CAST(0.5 AS ${dialect === "postgres" ? sqlTag.raw("DOUBLE PRECISION") : dialect === "sqlite" ? sqlTag.raw("REAL") : sqlTag.raw("DOUBLE")}) AS approximate_value
  `);
  assert.equal(typeof approximate.approximate_value, "number");
  assert.equal(approximate.approximate_value, 0.5);
  let integralApproximateError;
  try {
    await db.one(sqlTag.rows`
      SELECT CAST(42 AS ${dialect === "postgres" ? sqlTag.raw("DOUBLE PRECISION") : dialect === "sqlite" ? sqlTag.raw("REAL") : sqlTag.raw("DOUBLE")}) AS approximate_integer
    `);
  } catch (error) {
    integralApproximateError = error?.code;
  }
  assert.equal(integralApproximateError, "BRAID_RESULT_EXACTNESS");
  const temporalAndJson = dialect === "postgres"
    ? await db.one(sqlTag.rows`SELECT TIMESTAMP '2026-09-15 12:34:56.123456' AS temporal_value, '{"kind":"bun","exact":9007199254740993}'::JSONB AS json_value`)
    : dialect === "mysql" || dialect === "mariadb"
      ? await db.one(sqlTag.rows`SELECT CAST('2026-09-15 12:34:56.123456' AS DATETIME(6)) AS temporal_value, JSON_OBJECT('kind', 'bun', 'exact', CAST('9007199254740993' AS DECIMAL(20, 0))) AS json_value`)
      : await db.one(sqlTag.rows`SELECT CAST('2026-09-15 12:34:56.123456' AS TEXT) AS temporal_value, json(${'{"kind":"bun","exact":9007199254740993}'}) AS json_value`);
  if (dialect === "sqlite") {
    await assert.rejects(db.one(sqlTag.rows`SELECT json('{"kind":"bun","exact":9007199254740993}') AS json_value`),
      (error) => error.code === "BRAID_RESULT_KIND");
    resultCarriers.mixedQuoteLiteral = "native parser misclassification rejected";
  }
  const temporalParts = dialect === "postgres"
    ? await db.one(sqlTag.rows`SELECT CAST(${"2026-09-15"} AS DATE) AS date_value, CAST(${"12:34:56.123456"} AS TIME) AS time_value`)
    : dialect === "sqlite"
      ? await db.one(sqlTag.rows`SELECT date(${"2026-09-15"}) AS date_value, CAST(${"12:34:56.123456"} AS TEXT) AS time_value`)
      : await db.one(sqlTag.rows`SELECT CAST(${"2026-09-15"} AS DATE) AS date_value, CAST(${"12:34:56.123456"} AS TIME(6)) AS time_value`);
  assert.equal(typeof temporalParts.time_value, "string");
  assert.match(temporalParts.time_value, /^12:34:56(?:\.123456)?$/u);
  if (dialect === "sqlite") assert.equal(temporalParts.date_value, "2026-09-15");
  else assert.ok(temporalParts.date_value instanceof Date);
  const bytes = new Uint8Array([0, 255, 39, 0]);
  let binary;
  if (dialect === "mysql" || dialect === "mariadb") {
    await assert.rejects(db.one(sqlTag.rows`SELECT UNHEX('00ff2700') AS binary_value`),
      (error) => error.code === "BRAID_RESULT_EXACTNESS");
    const encoded = await db.one(sqlTag.rows`SELECT HEX(${bytes}) AS binary_hex`);
    assert.equal(encoded.binary_hex, "00FF2700");
    binary = { nativeOutput: "ambiguous bytes rejected", explicitHex: encoded.binary_hex };
  } else {
    const row = await db.one(sqlTag.rows`SELECT ${bytes} AS binary_value`);
    assert.ok(row.binary_value instanceof Uint8Array);
    assert.deepEqual([...row.binary_value], [...bytes]);
    binary = { nativeOutput: "Uint8Array", bytes: [...row.binary_value] };
  }
  let decimalProbe;
  try {
    decimalProbe = await db.one(sqlTag.rows`
      SELECT CAST('12345678901234567890.123456789' AS ${dialect === "postgres" ? sqlTag.raw("NUMERIC") : dialect === "sqlite" ? sqlTag.raw("NUMERIC") : sqlTag.raw("DECIMAL(30, 9)")}) AS exact_decimal
    `);
  } catch (error) {
    if (dialect === "postgres" || error?.code !== "BRAID_RESULT_EXACTNESS") throw error;
    decimalProbe = { exact_decimal: undefined, error: error.code };
  }
  if (dialect === "mysql" || dialect === "mariadb") {
    const explicit = await db.one(sqlTag.rows`SELECT CAST(CAST(${"12345678901234567890.123456789"} AS DECIMAL(30, 9)) AS CHAR) AS exact_decimal`);
    assert.equal(explicit.exact_decimal, "12345678901234567890.123456789");
    decimalProbe.explicit_decimal_text = explicit.exact_decimal;
  }
  const representation = {
    exact_integer: exactInteger.exact_integer,
    exact_decimal: decimalProbe.exact_decimal,
    approximate_value: approximate.approximate_value,
    approximate_integer_error: integralApproximateError,
    temporal_value: temporalAndJson.temporal_value,
    temporal_parts: temporalParts,
    host_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    binary,
    json_value: temporalAndJson.json_value,
    json_transport: typeof temporalAndJson.json_value === "string" ? "text" : "native",
    ...(decimalProbe.error === undefined ? {} : { decimalError: decimalProbe.error }),
    ...(decimalProbe.explicit_decimal_text === undefined ? {} : { explicit_decimal_text: decimalProbe.explicit_decimal_text }),
  };
  assert.equal(typeof representation.exact_integer, "string");
  if (dialect === "sqlite") {
    assert.equal(representation.decimalError, "BRAID_RESULT_EXACTNESS");
    assert.equal(typeof representation.temporal_value, "string");
    assert.equal(typeof representation.json_value, "string");
    assert.match(representation.json_value, /9007199254740993/u);
  } else {
    if (dialect === "postgres") assert.equal(representation.exact_decimal, "12345678901234567890.123456789");
    else assert.equal(representation.decimalError, "BRAID_RESULT_EXACTNESS");
    assert.ok(representation.temporal_value instanceof Date);
    if (dialect === "mariadb") {
      assert.equal(representation.json_transport, "text");
      assert.match(representation.json_value, /"exact":\s*9007199254740993/u);
    } else {
      assert.equal(representation.json_transport, "native");
      assert.equal(representation.json_value.kind, "bun");
      assert.equal(representation.json_value.exact, 9007199254740992);
    }
  }

  const unsupported = {};
  try {
    for await (const _row of db.stream(sqlTag.rows`SELECT 1`)) {}
  } catch (error) {
    unsupported.stream = { code: error?.code, feature: error?.feature };
  }
  assert.equal(unsupported.stream?.code, "BRAID_STREAM_UNSUPPORTED");
  try {
    await db.call(sqlTag.call`CALL braid_bun_sql_matrix()`);
  } catch (error) {
    unsupported.call = { code: error?.code, feature: error?.feature };
  }
  assert.equal(unsupported.call?.code, "BRAID_CALL_UNSUPPORTED");

  const controller = new AbortController();
  const cancellation = { capability: environment.capabilities["statement.cancel"]?.status };
  const cancellationPromise = db.execute(sleepQuery(sqlTag), { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("matrix cancellation")), 25);
  try {
    await cancellationPromise;
    cancellation.observed = "completed";
  } catch (error) {
    cancellation.observed = error?.code ?? error?.name ?? "error";
  }
  if (cancellation.capability === "guaranteed" || cancellation.capability === "guarded") {
    assert.notEqual(cancellation.observed, "completed");
  }
  if (cancellation.capability === "unsupported") {
    assert.equal(cancellation.observed, "BRAID_CANCEL_UNSUPPORTED");
  } else {
    const afterCancellation = await db.one(sqlTag.rows`SELECT 1 AS reuse_after_cancel`);
    assert.equal(afterCancellation.reuse_after_cancel, 1);
    cancellation.reuse = "ok";
  }

  const result = {
    dialect,
    urlSource: envNames[dialect].find((name) => process.env[name]) ?? "in-memory",
    environment,
    sessionIds,
    prepared: preparedRow,
    preparedCommand: preparedCommandResult,
    bulk: bulkResult,
    nativeTransport: {
      transport: "native-value-template",
      ordinaryValues: "bound",
      structuralHelpers: "rejected-as-values",
      inactiveBranch: "lazy",
    },
    resultCarriers,
    transaction: transactionResult,
    transactionModes,
    standardSchema: schemaRow,
    representations: representation,
    unsupported,
    cancellation,
    supportEvidence: {
      status: "compatible",
      reason: "Bun.SQL is exercised against the existing database target; no Bun tuple is promoted to official support by this matrix.",
      existingTarget: manifest?.id ?? null,
      existingTargetVersion: manifest?.database?.version ?? null,
    },
    observedTuple: {
      targetId: process.env[`SQLBRAID_BUN_SQL_${dialect.toUpperCase()}_TARGET`] ?? `bun-sql-${dialect}`,
      database: {
        product: environment.database.product,
        ...observedVersion,
        edition: process.env[`SQLBRAID_BUN_SQL_${dialect.toUpperCase()}_EDITION`]
          ?? (dialect === "sqlite" ? "bun-embedded"
            : process.env[`SQLBRAID_${dialect.toUpperCase()}_EDITION`] ?? manifest?.database?.edition)
          ?? "bun-sql-runtime",
      },
      driver: {
        id: environment.driver.id,
        version: Bun.version,
        profile: environment.driver.profile,
      },
      runtime: { id: "bun", version: Bun.version },
      typePolicy: environment.typePolicy,
      connectionOptions: representationProfileFor(dialect).connectionOptions,
      capabilities: environment.capabilities,
    },
  };
  const observationsDirectory = process.env.SQLBRAID_SUPPORT_EVIDENCE_DIR;
  if (observationsDirectory) {
    await mkdir(observationsDirectory, { recursive: true });
    await writeFile(`${observationsDirectory}/${dialect}.json`, `${JSON.stringify(result.observedTuple, null, 2)}\n`);
  }
  await client.close?.();
  return result;
}

const selected = process.argv.slice(2);
const dialects = selected.length === 0 ? Object.keys(dialectTags) : selected;
for (const dialect of dialects) assert.ok(Object.hasOwn(dialectTags, dialect), `Unknown Bun.SQL dialect: ${dialect}`);
const results = [];
for (const dialect of dialects) results.push(await runDialect(dialect));
console.log(JSON.stringify({ runtime: { id: "bun", version: Bun.version }, results }, null, 2));
