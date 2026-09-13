import type { DatabaseOptions, QueryExecutor, QueryExecutionResult, RenderedQuery, RoutineCallResult } from "@sqlbraid/core";
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
  iterate?(...values: readonly unknown[]): IterableIterator<unknown>;
  run(...values: readonly unknown[]): { readonly changes?: number | bigint; readonly lastInsertRowid?: number | bigint };
  columns(): readonly SqliteColumnLike[];
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec?(sql: string): void;
}

function plainRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return Object.fromEntries(Object.entries(value));
}

function resultColumns(statement: SqliteStatementLike): readonly SqliteColumnLike[] {
  const columns = statement.columns();
  const names = new Set<string>();
  for (const column of columns) {
    const name = column.name ?? column.column;
    if (name != null && names.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate SQLite result label ${name}.`);
    if (name != null) names.add(name);
  }
  return columns;
}

function unsupportedCall(): never {
  throw new Error("BRAID_CALL_UNSUPPORTED: SQLite adapter does not support routine calls.");
}

function assertParameterHintsUnsupported(rendered: RenderedQuery): void {
  if (rendered.parameterHints?.some((hint) => hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: SQLite adapter does not support explicit bind type hints.");
  }
}

export function createNodeSqliteExecutor(database: SqliteDatabaseLike): QueryExecutor {
  const control = database.exec ? async (sql: string): Promise<void> => { database.exec?.(sql); } : undefined;
  return {
    ownershipKey: database,
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      if (rendered.resultKind === "call") unsupportedCall();
      const statement = database.prepare(rendered.text);
      const columns = resultColumns(statement);
      if (columns.length > 0) {
        const rows = statement.all(...rendered.values).map(plainRow);
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      const result = statement.run(...rendered.values);
      const changes = result.changes === undefined ? undefined : Number(result.changes);
      return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes, insertId: result.lastInsertRowid } };
    },
    async call<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      unsupportedCall();
    },
    async *stream<Row>(rendered: RenderedQuery, signal?: AbortSignal): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      const statement = database.prepare(rendered.text);
      if (!statement.iterate) throw new Error("BRAID_STREAM_UNSUPPORTED: SQLite statement does not expose iteration.");
      if (resultColumns(statement).length === 0) throw new Error("BRAID_RESULT_KIND: SQLite stream requires a row-producing statement.");
      for (const row of statement.iterate(...rendered.values)) {
        signal?.throwIfAborted();
        yield plainRow(row) as Row;
      }
    },
    begin: control ? () => control("BEGIN") : undefined,
    commit: control ? () => control("COMMIT") : undefined,
    rollback: control ? () => control("ROLLBACK") : undefined,
    savepoint: control ? (name) => control(`SAVEPOINT ${name}`) : undefined,
    rollbackTo: control ? (name) => control(`ROLLBACK TO SAVEPOINT ${name}`) : undefined,
    releaseSavepoint: control ? (name) => control(`RELEASE SAVEPOINT ${name}`) : undefined,
  };
}

export function createNodeSqliteDatabase(database: SqliteDatabaseLike, options: DatabaseOptions = {}) {
  return createDatabase(createNodeSqliteExecutor(database), options);
}
