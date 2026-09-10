import type { QueryExecutor, QueryExecutionResult, RenderedQuery } from "../../core/src/index.js";
import { createDatabase } from "../../runtime/src/index.js";

export interface SqliteStatementLike {
  all(...values: readonly unknown[]): readonly unknown[];
  run(...values: readonly unknown[]): { readonly changes?: number; readonly lastInsertRowid?: number | bigint };
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec?(sql: string): void;
}

export function createNodeSqliteExecutor(database: SqliteDatabaseLike): QueryExecutor {
  return {
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const statement = database.prepare(rendered.text);
      if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(rendered.text)) {
        const rows = statement.all(...rendered.values) as readonly Row[];
        return { rows, rowCount: rows.length };
      }
      const result = statement.run(...rendered.values);
      return { rows: [], rowCount: result.changes };
    },
  };
}

export function createNodeSqliteDatabase<Row = unknown>(database: SqliteDatabaseLike) {
  return createDatabase<Row>(createNodeSqliteExecutor(database));
}
