import assert from "node:assert/strict";
import { test } from "vitest";
import type { DatabaseEnvironment } from "@sqlbraid/core";
import { dialect as postgres } from "@sqlbraid/postgres";
import { dialect as mysql } from "@sqlbraid/mysql";
import { dialect as mariadb } from "@sqlbraid/mariadb";
import { dialect as sqlite } from "@sqlbraid/sqlite";
import { dialect as oracle } from "@sqlbraid/oracle";
import { dialect as mssql } from "@sqlbraid/mssql";
import {
  createMigrationSql,
  historyTable,
  isClaimConflict,
  isMigrationBusy,
  isMissingHistory,
  transactionalDdl,
} from "../packages/migrate/src/dialect.js";
import { historySql as postgresHistory } from "../packages/migrate/src/bootstrap/postgres.js";
import { historySql as mysqlHistory } from "../packages/migrate/src/bootstrap/mysql.js";
import { historySql as mariadbHistory } from "../packages/migrate/src/bootstrap/mariadb.js";
import { historySql as sqliteHistory } from "../packages/migrate/src/bootstrap/sqlite.js";
import { historySql as oracleHistory } from "../packages/migrate/src/bootstrap/oracle.js";
import { historySql as mssqlHistory } from "../packages/migrate/src/bootstrap/mssql.js";

test("history identifiers always quote including the Oracle leading underscore", () => {
  assert.equal(historyTable(oracle), '"_sqlbraid_migrations"');
  assert.equal(historyTable(oracle, 'ta"ble', 'sch"ema'), '"sch""ema"."ta""ble"');
  assert.equal(historyTable(mysql, "ta`ble", "sch`ema"), "`sch``ema`.`ta``ble`");
  assert.equal(historyTable(mssql, "ta]ble", "sch]ema"), "[sch]]ema].[ta]]ble]");
  assert.equal(historyTable(postgres, "a.b"), '"a.b"');
  assert.throws(() => historyTable(sqlite, ""), { code: "BRAID_MIGRATE_SOURCE" });
  assert.throws(() => historyTable(sqlite, "table", "\0"), { code: "BRAID_MIGRATE_SOURCE" });
});

test("migration metadata values stay bound through the existing SQL template seam", () => {
  for (const dialect of [postgres, mysql, mariadb, sqlite, oracle, mssql]) {
    const sql = createMigrationSql(dialect);
    const scope = "x'; DROP TABLE users; --";
    const rendered =
      sql.rows`SELECT ${sql.ident("installed_rank")} FROM ${sql.raw(historyTable(dialect))} WHERE ${sql.ident("scope")} = ${scope}`.render();
    assert.equal(rendered.dialectId, dialect.id);
    assert.deepEqual(
      rendered.parameters.map(({ value }) => value),
      [scope],
    );
    assert.equal(rendered.segments.join("").includes(scope), false);
  }
  assert.throws(() => createMigrationSql({ id: "unknown", quoteIdentifier: postgres.quoteIdentifier }), {
    code: "BRAID_MIGRATE_SOURCE",
  });
});

test("each bootstrap stores every history field and the composite claim primary key", () => {
  const columns = [
    "scope",
    "installed_rank",
    "version",
    "kind",
    "description",
    "source",
    "dialect",
    "checksum",
    "status",
    "execution_id",
    "applied_by",
    "started_at",
    "duration_ms",
    "schema_hash",
  ];
  for (const [dialect, bootstrap] of [
    [postgres, postgresHistory],
    [mysql, mysqlHistory],
    [mariadb, mariadbHistory],
    [sqlite, sqliteHistory],
    [oracle, oracleHistory],
    [mssql, mssqlHistory],
  ] as const) {
    const ddl = bootstrap(historyTable(dialect));
    assert.ok(ddl.includes(historyTable(dialect)));
    for (const column of columns) assert.ok(ddl.includes(dialect.quoteIdentifier(column)), `${dialect.id}: ${column}`);
    assert.ok(
      ddl.includes(`PRIMARY KEY (${dialect.quoteIdentifier("scope")}, ${dialect.quoteIdentifier("installed_rank")})`),
    );
    assert.doesNotMatch(ddl, /CURRENT_TIMESTAMP|AUTO_INCREMENT|IDENTITY/u);
  }
});

test("transactional DDL is selected from dialect semantics and driver environment evidence", () => {
  const environment: DatabaseEnvironment = {
    database: { product: "sqlite" },
    driver: { id: "test" },
    runtime: { id: "test" },
    capabilities: { transaction: { status: "guaranteed" } },
    supportMatch: { status: "compatible" },
  };
  for (const dialect of [postgres, sqlite, mssql]) assert.equal(transactionalDdl(dialect, environment), true);
  for (const dialect of [mysql, mariadb, oracle]) assert.equal(transactionalDdl(dialect, environment), false);
  for (const status of ["guarded", "unsupported"] as const) {
    assert.equal(
      transactionalDdl(sqlite, {
        ...environment,
        driver: { id: "cloudflare-d1" },
        capabilities: { transaction: { status } },
      }),
      false,
    );
  }
  assert.equal(transactionalDdl(sqlite, { ...environment, capabilities: {} }), false);
});

test("missing history is distinguished from permissions, syntax, and connection errors", () => {
  assert.equal(isMissingHistory({ code: "42P01" }, postgres), true);
  assert.equal(isMissingHistory({ code: "42501" }, postgres), false);
  assert.equal(isMissingHistory({ cause: { errno: 1146 } }, mysql), true);
  assert.equal(isMissingHistory({ errorNum: 942 }, oracle), true);
  assert.equal(isMissingHistory({ originalError: { info: { number: 208 } } }, mssql), true);
  assert.equal(isMissingHistory(new Error("D1_ERROR: no such table: _sqlbraid_migrations"), sqlite), true);
  assert.equal(isMissingHistory(new Error("Connection reset"), sqlite), false);
});

test("only unique claim violations retry, not arbitrary SQLite constraints", () => {
  assert.equal(isClaimConflict({ code: "23505" }, postgres), true);
  assert.equal(isClaimConflict({ errno: 1062 }, mariadb), true);
  assert.equal(isClaimConflict({ errorNum: 1 }, oracle), true);
  assert.equal(isClaimConflict({ number: 2627 }, mssql), true);
  assert.equal(isClaimConflict({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }, sqlite), true);
  assert.equal(
    isClaimConflict(
      { code: "SQLITE_CONSTRAINT", message: "UNIQUE constraint failed: history.scope, history.installed_rank" },
      sqlite,
    ),
    true,
  );
  assert.equal(isClaimConflict({ code: "SQLITE_CONSTRAINT_NOTNULL" }, sqlite), false);
  assert.equal(isClaimConflict({ code: "SQLITE_CONSTRAINT", message: "CHECK constraint failed: x" }, sqlite), false);
  assert.equal(isMigrationBusy({ code: "SQLITE_BUSY" }, sqlite), true);
  assert.equal(isMigrationBusy({ code: "SQLITE_BUSY" }, postgres), false);
  const cyclic: { cause?: unknown; code: string } = { code: "42501" };
  cyclic.cause = cyclic;
  assert.equal(isMissingHistory(cyclic, postgres), false);
});
