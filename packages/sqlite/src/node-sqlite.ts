import { lexSql } from "@sqlbraid/ast";
import type { QueryExecutor, QueryExecutionResult, RenderedQuery } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";

export interface SqliteColumnLike {
  readonly name?: string | null;
  readonly column?: string | null;
  readonly database?: string | null;
  readonly table?: string | null;
  readonly type?: string | null;
}

export interface SqliteStatementLike {
  all(...values: readonly unknown[]): readonly unknown[];
  run(...values: readonly unknown[]): { readonly changes?: number | bigint; readonly lastInsertRowid?: number | bigint };
  columns?(): readonly SqliteColumnLike[];
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec?(sql: string): void;
}

function plainRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return Object.fromEntries(Object.entries(value));
}

function isRowStatement(statement: SqliteStatementLike, sql: string): boolean {
  if (statement.columns) {
    try {
      const columns = statement.columns();
      const names = new Set<string>();
      for (const column of columns) {
        const name = column.name ?? column.column;
        if (name && names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQLite result label ${name}.`);
        if (name) names.add(name);
      }
      if (columns.length > 0) return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("BRAID_RESULT_COLUMNS:")) throw error;
    }
  }
  try {
    const tokens = lexSql(sql).filter((token) => token.kind !== "comment" && token.kind !== "eof");
    const first = tokens[0]?.text.toUpperCase();
    if (["SELECT", "VALUES", "PRAGMA", "EXPLAIN"].includes(first ?? "")) return true;
    if (first === "WITH") return tokens.some((token) => token.text.toUpperCase() === "RETURNING");
  } catch { return false; }
  return false;
}

export function createNodeSqliteExecutor(database: SqliteDatabaseLike): QueryExecutor {
  const control = database.exec ? async (sql: string): Promise<void> => { database.exec?.(sql); } : undefined;
  return {
    ownershipKey: database,
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const statement = database.prepare(rendered.text);
      if (isRowStatement(statement, rendered.text)) {
        const rows = statement.all(...rendered.values).map(plainRow);
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      const result = statement.run(...rendered.values);
      const changes = result.changes === undefined ? undefined : Number(result.changes);
      return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes, insertId: result.lastInsertRowid } };
    },
    begin: control ? () => control("BEGIN") : undefined,
    commit: control ? () => control("COMMIT") : undefined,
    rollback: control ? () => control("ROLLBACK") : undefined,
    savepoint: control ? (name) => control(`SAVEPOINT ${name}`) : undefined,
    rollbackTo: control ? (name) => control(`ROLLBACK TO SAVEPOINT ${name}`) : undefined,
    releaseSavepoint: control ? (name) => control(`RELEASE SAVEPOINT ${name}`) : undefined,
  };
}

export function createNodeSqliteDatabase(database: SqliteDatabaseLike) {
  return createDatabase(createNodeSqliteExecutor(database));
}
