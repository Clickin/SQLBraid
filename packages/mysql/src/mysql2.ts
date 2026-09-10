import type { QueryExecutor, QueryExecutionResult, RenderedQuery } from "../../core/src/index.js";
import { createDatabase } from "../../runtime/src/index.js";

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: readonly unknown[]): Promise<readonly [readonly unknown[], unknown]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export function createMysql2Executor(connection: Mysql2ConnectionLike): QueryExecutor {
  return {
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const [rows] = await connection.execute(rendered.text, rendered.values);
      return { rows: rows as readonly Row[], rowCount: rows.length };
    },
    begin: connection.beginTransaction?.bind(connection),
    commit: connection.commit?.bind(connection),
    rollback: connection.rollback?.bind(connection),
  };
}

export function createMysql2Database<Row = unknown>(connection: Mysql2ConnectionLike) {
  return createDatabase<Row>(createMysql2Executor(connection));
}
