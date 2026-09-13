import type {
  DatabaseOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedStatement,
  RoutineCallResult,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
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

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: SQLite adapter does not support explicit bind type hints.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();

export const nodeSqliteStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "node-sqlite",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "node-sqlite",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "sqlite",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? nodeSqliteStatementBinding.describe(statement, defaultBindingContext);
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: SQLite description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: SQLite binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

export function createNodeSqliteExecutor(database: SqliteDatabaseLike): QueryExecutor {
  const control = database.exec ? async (sql: string): Promise<void> => { database.exec?.(sql); } : undefined;
  return {
    ownershipKey: database,
    statementBinding: nodeSqliteStatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      if (rendered.resultKind === "call") unsupportedCall();
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      const columns = resultColumns(statement);
      if (columns.length > 0) {
        const rows = statement.all(...prepared.values).map(plainRow);
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      const result = statement.run(...prepared.values);
      const changes = result.changes === undefined ? undefined : Number(result.changes);
      return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes, insertId: result.lastInsertRowid } };
    },
    async call<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<RoutineCallResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      unsupportedCall();
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      if (!statement.iterate) throw new Error("BRAID_STREAM_UNSUPPORTED: SQLite statement does not expose iteration.");
      if (resultColumns(statement).length === 0) throw new Error("BRAID_RESULT_KIND: SQLite stream requires a row-producing statement.");
      for (const row of statement.iterate(...prepared.values)) {
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
