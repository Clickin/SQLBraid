import type { Database, DatabaseEnvironment, Dialect, SqlTag } from "@sqlbraid/core";
import { createSqlTag } from "@sqlbraid/template";
import { MigrationError } from "./errors.js";
import { historySql as postgresHistory } from "./bootstrap/postgres.js";
import { historySql as mysqlHistory } from "./bootstrap/mysql.js";
import { historySql as mariadbHistory } from "./bootstrap/mariadb.js";
import { historySql as sqliteHistory } from "./bootstrap/sqlite.js";
import { historySql as oracleHistory } from "./bootstrap/oracle.js";
import { historySql as mssqlHistory } from "./bootstrap/mssql.js";

const bootstraps: Readonly<Record<string, (table: string) => string>> = {
  postgres: postgresHistory,
  mysql: mysqlHistory,
  mariadb: mariadbHistory,
  sqlite: sqliteHistory,
  oracle: oracleHistory,
  mssql: mssqlHistory,
};

export function createMigrationSql(dialect: Dialect): SqlTag {
  if (!Object.hasOwn(bootstraps, dialect.id)) {
    throw new MigrationError("BRAID_MIGRATE_SOURCE", `Unsupported migration dialect: ${dialect.id}`);
  }
  return createSqlTag({ dialect });
}

export function historyTable(dialect: Dialect, table = "_sqlbraid_migrations", schema?: string): string {
  if (!table || table.includes("\0") || (schema !== undefined && (!schema || schema.includes("\0")))) {
    throw new MigrationError(
      "BRAID_MIGRATE_SOURCE",
      "History table and schema must be nonempty identifiers without NUL.",
    );
  }
  return schema === undefined
    ? dialect.quoteIdentifier(table)
    : `${dialect.quoteIdentifier(schema)}.${dialect.quoteIdentifier(table)}`;
}

function errorRecords(error: unknown): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending: unknown[] = [error];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || records.includes(value as Record<string, unknown>)) continue;
    const record = value as Record<string, unknown>;
    records.push(record);
    pending.push(record.cause, record.originalError, record.info);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return records;
}

function hasCode(record: Record<string, unknown>, ...codes: readonly (string | number)[]): boolean {
  return [record.code, record.errno, record.errorNum, record.number, record.errcode].some((code) =>
    codes.some((expected) => code === expected),
  );
}

export function isMissingHistory(error: unknown, dialect: Dialect): boolean {
  return errorRecords(error).some((record) => {
    switch (dialect.id) {
      case "postgres":
        return hasCode(record, "42P01");
      case "mysql":
      case "mariadb":
        return hasCode(record, "ER_NO_SUCH_TABLE", 1146);
      case "oracle":
        return hasCode(record, "ORA-00942", 942);
      case "mssql":
        return hasCode(record, 208);
      case "sqlite":
        return /\bno such table:/iu.test(String(record.message ?? ""));
      default:
        return false;
    }
  });
}

export function isClaimConflict(error: unknown, dialect: Dialect): boolean {
  return errorRecords(error).some((record) => {
    switch (dialect.id) {
      case "postgres":
        return hasCode(record, "23505");
      case "mysql":
      case "mariadb":
        return hasCode(record, "ER_DUP_ENTRY", 1062);
      case "oracle":
        return hasCode(record, "ORA-00001", 1);
      case "mssql":
        return hasCode(record, 2601, 2627);
      case "sqlite":
        return (
          hasCode(record, "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE", 1555, 2067) ||
          /\b(?:UNIQUE|PRIMARY KEY) constraint failed:/iu.test(String(record.message ?? ""))
        );
      default:
        return false;
    }
  });
}

export function isMigrationBusy(error: unknown, dialect: Dialect): boolean {
  if (dialect.id !== "sqlite") return false;
  return errorRecords(error).some(
    (record) =>
      hasCode(record, "SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", 5, 6, 517) ||
      /\bdatabase (?:is )?locked\b/iu.test(String(record.message ?? "")),
  );
}

export async function bootstrapHistory(db: Database, dialect: Dialect, table?: string, schema?: string): Promise<void> {
  const sql = createMigrationSql(dialect);
  const statement = bootstraps[dialect.id](historyTable(dialect, table, schema));
  try {
    await db.execute(sql.command`${sql.raw(statement)}`);
  } catch (error) {
    // Oracle/MSSQL lack IF NOT EXISTS; PostgreSQL can race creating its catalog entries.
    const exists = errorRecords(error).some((record) =>
      dialect.id === "oracle"
        ? hasCode(record, "ORA-00955", 955)
        : dialect.id === "mssql"
          ? hasCode(record, 2714)
          : dialect.id === "postgres" &&
            (hasCode(record, "42P07") ||
              (hasCode(record, "23505") &&
                ["pg_type_typname_nsp_index", "pg_class_relname_nsp_index"].includes(String(record.constraint)))),
    );
    if (!exists) throw error;
    // Check that the existing object has the expected history columns.
    await db.all(
      sql.rows`SELECT ${sql.ident("scope")}, ${sql.ident("installed_rank")}, ${sql.ident("version")}, ${sql.ident("kind")}, ${sql.ident("description")}, ${sql.ident("source")}, ${sql.ident("dialect")}, ${sql.ident("checksum")}, ${sql.ident("status")}, ${sql.ident("execution_id")}, ${sql.ident("applied_by")}, ${sql.ident("started_at")}, ${sql.ident("duration_ms")}, ${sql.ident("schema_hash")} FROM ${sql.raw(historyTable(dialect, table, schema))} WHERE 1 = 0`,
    );
  }
}

export function transactionalDdl(dialect: Dialect, environment: DatabaseEnvironment): boolean {
  return (
    ["postgres", "mssql", "sqlite"].includes(dialect.id) &&
    environment.capabilities.transaction?.status === "guaranteed"
  );
}

export interface MigrationLockOptions {
  readonly scope: string;
  readonly table?: string;
  readonly schema?: string;
  readonly busyTimeoutMs: number;
  readonly onAcquire?: () => void;
  readonly onRelease?: () => void;
}

function lockName(dialect: Dialect, options: MigrationLockOptions): string {
  const resource = JSON.stringify([
    dialect.id,
    options.schema ?? "",
    options.table ?? "_sqlbraid_migrations",
    options.scope,
  ]);
  // Native lock names are bounded (MySQL: 64 bytes). Collisions only serialize extra runners.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < resource.length; index += 1) {
    first = Math.imul(first ^ resource.charCodeAt(index), 0x01000193);
    second = Math.imul(second ^ resource.charCodeAt(index), 0x85ebca6b);
  }
  return `sqlbraid:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export async function withMigrationLock<T>(
  db: Database,
  dialect: Dialect,
  options: MigrationLockOptions,
  callback: (database: Database) => Promise<T>,
): Promise<T> {
  const environment = await db.environment();
  if (environment.capabilities["session.pinned"]?.status !== "guaranteed") return callback(db);
  if (!["postgres", "mysql", "mariadb", "mssql"].includes(dialect.id)) return db.session(callback);
  const sql = createMigrationSql(dialect);
  const name = lockName(dialect, options);
  const busy = (): never => {
    throw new MigrationError("BRAID_MIGRATE_BUSY", `Timed out acquiring migration lock for scope ${options.scope}.`);
  };
  return db.session(async (session) => {
    let possiblyHeld = false;
    let failed = false;
    let primaryError: unknown;
    try {
      if (dialect.id === "postgres") {
        const deadline = Date.now() + options.busyTimeoutMs;
        while (true) {
          // An observer can throw after the server acquired the lock.
          possiblyHeld = true;
          const row = await session.one(
            sql.rows<{
              acquired: boolean;
            }>`SELECT pg_try_advisory_lock(hashtext(${name}), hashtext(current_database())) AS acquired`,
          );
          possiblyHeld = row.acquired;
          if (possiblyHeld) break;
          if (Date.now() >= deadline) busy();
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        }
      } else if (dialect.id === "mssql") {
        possiblyHeld = true;
        const result = await session.call(
          sql.call({
            procedure: {
              name: "sys.sp_getapplock",
              parameterNames: ["Resource", "LockMode", "LockOwner", "LockTimeout"],
            },
          })`${name}, ${"Exclusive"}, ${"Session"}, ${sql.bind(options.busyTimeoutMs, { databaseType: "int" })}`,
        );
        if (typeof result.returnValue !== "number" || !Number.isInteger(result.returnValue)) {
          throw new Error("SQL Server sp_getapplock did not return an integer status.");
        }
        possiblyHeld = result.returnValue >= 0;
        if (!possiblyHeld) busy();
      } else {
        possiblyHeld = true;
        const row = await session.one(
          sql.rows<{
            acquired: number | string | null;
          }>`SELECT GET_LOCK(${name}, ${options.busyTimeoutMs / 1000}) AS acquired`,
        );
        possiblyHeld = Number(row.acquired) === 1;
        if (!possiblyHeld) busy();
      }
      options.onAcquire?.();
      return await callback(session);
    } catch (error) {
      failed = true;
      primaryError = error;
      throw error;
    } finally {
      if (possiblyHeld) {
        try {
          if (dialect.id === "postgres") {
            await session.one(
              sql.rows`SELECT pg_advisory_unlock(hashtext(${name}), hashtext(current_database())) AS released`,
            );
          } else if (dialect.id === "mssql") {
            const result = await session.call(
              sql.call({
                procedure: { name: "sys.sp_releaseapplock", parameterNames: ["Resource", "LockOwner"] },
              })`${name}, ${"Session"}`,
            );
            if (
              typeof result.returnValue !== "number" ||
              !Number.isInteger(result.returnValue) ||
              result.returnValue < 0
            ) {
              throw new Error(`SQL Server sp_releaseapplock failed with status ${String(result.returnValue)}.`);
            }
          } else {
            await session.one(sql.rows`SELECT RELEASE_LOCK(${name}) AS released`);
          }
          options.onRelease?.();
        } catch (error) {
          if (failed)
            throw new AggregateError([primaryError, error], "Migration and lock cleanup both failed.", {
              cause: error,
            });
          throw error;
        }
      }
    }
  });
}
