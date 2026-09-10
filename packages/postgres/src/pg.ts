import type { QueryExecutor, QueryExecutionResult, RenderedQuery } from "../../core/src/index.js";
import { createDatabase } from "../../runtime/src/index.js";

export interface PgClientLike {
  query(config: { readonly text: string; readonly values: readonly unknown[] }): Promise<{ readonly rows: readonly unknown[]; readonly rowCount?: number }>;
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly unknown[]; readonly rowCount?: number }>;
  release?(): void;
}

export function createPgExecutor(client: PgClientLike): QueryExecutor {
  return {
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const result = await client.query({ text: rendered.text, values: rendered.values });
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
    },
  };
}

export function createPgDatabase<Row = unknown>(client: PgClientLike) {
  return createDatabase<Row>(createPgExecutor(client));
}
