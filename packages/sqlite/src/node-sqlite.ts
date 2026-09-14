import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DatabaseOptions,
  DriverRoutineResult,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createBulkBindingDescription, createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
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
  setReadBigInts?(enabled: boolean): void;
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  exec?(sql: string): void;
}

export type SqliteIntegerMode = "number" | "bigint";

export interface SqliteExecutorOptions {
  readonly integerMode?: SqliteIntegerMode;
}

export interface SqliteDatabaseOptions extends DatabaseOptions, SqliteExecutorOptions {}

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

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) unsupportedCall();
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: SQLite adapter does not support explicit bind type hints.");
  }
}

function assertNodeSqliteValue(value: unknown): void {
  if (value === null || typeof value === "number" || typeof value === "string") return;
  if (typeof value === "bigint") {
    if (BigInt.asIntN(64, value) !== value) {
      throw new RangeError("BRAID_INTEGER_UNSAFE: node:sqlite BigInt values must fit signed 64-bit range.");
    }
    return;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return;
  throw new TypeError("BRAID_BIND_VALUE_UNSUPPORTED: node:sqlite binds support null, numbers, bigint, strings, and ArrayBufferView values.");
}

function assertNodeSqliteValues(values: readonly unknown[]): void {
  for (const value of values) assertNodeSqliteValue(value);
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const nodeSqliteStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "node-sqlite",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
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
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    if (statement.resultKind !== "command") throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk requires command queries.");
    if (statement.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
      throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk does not support OUT or INOUT parameters.");
    }
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk parameter cardinality changed.");
      assertNodeSqliteValues(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "node-sqlite",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "simple", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

function bindingContext(statement: RenderedStatement): StatementBindingContext {
  return {
    dialectId: statement.dialectId,
    requestedReuse: "auto",
  };
}

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? nodeSqliteStatementBinding.describe(statement, bindingContext(statement));
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: SQLite description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: SQLite binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function assertIntegerMode(integerMode: SqliteIntegerMode | undefined): SqliteIntegerMode {
  if (integerMode === undefined) return "number";
  if (integerMode !== "number" && integerMode !== "bigint") {
    throw new TypeError('SQLite integerMode must be "number" or "bigint".');
  }
  return integerMode;
}

function configureIntegerMode(statement: SqliteStatementLike, integerMode: SqliteIntegerMode): void {
  if (typeof statement.setReadBigInts !== "function") {
    if (integerMode === "bigint") {
      throw new Error("BRAID_INTEGER_MODE_UNSUPPORTED: SQLite statement does not expose setReadBigInts.");
    }
    return;
  }
  statement.setReadBigInts(integerMode === "bigint");
}

export function createNodeSqliteExecutor(database: SqliteDatabaseLike, options: SqliteExecutorOptions = {}): QueryExecutor {
  const integerMode = assertIntegerMode(options.integerMode);
  const control = database.exec ? async (sql: string): Promise<void> => { database.exec?.(sql); } : undefined;
  return {
    ownershipKey: database,
    statementBinding: nodeSqliteStatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertRoutineUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      configureIntegerMode(statement, integerMode);
      const columns = resultColumns(statement);
      if (columns.length > 0) {
        const rows = statement.all(...prepared.values).map(plainRow);
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      const result = statement.run(...prepared.values);
      const changes = result.changes === undefined ? undefined : Number(result.changes);
      return { rows: [], rowCount: changes, kind: "command", command: { affectedRows: changes, insertId: result.lastInsertRowid } };
    },
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription): Promise<BulkExecutionResult> {
      if (!binding || describedBulks.get(binding) !== bulk) {
        throw new TypeError("BRAID_BINDING_IDENTITY: node:sqlite bulk description belongs to another bulk or adapter.");
      }
      const prepared = binding.parameterizedSql;
      if (prepared === undefined) throw new Error("BRAID_BIND_TRANSPORT: SQLite bulk binding description did not provide parameterized SQL.");
      const native = database.prepare(prepared);
      configureIntegerMode(native, integerMode);
      if (resultColumns(native).length > 0) throw new Error("BRAID_BULK_SHAPE: node:sqlite bulk requires a non-row statement.");
      let affectedRows: number | undefined = 0;
      for (let index = 0; index < bulk.parameterSets.length; index += 1) {
        const result = native.run(...binding.valuesAt(index));
        if (result.changes === undefined) {
          affectedRows = undefined;
        } else if (affectedRows !== undefined) {
          affectedRows += Number(result.changes);
        }
      }
      return {
        inputCount: bulk.parameterSets.length,
        ...(affectedRows === undefined ? {} : { affectedRows }),
        executionMode: "prepared-loop",
      };
    },
    async call(rendered: RenderedStatement, _binding?: StatementBindingDescription): Promise<DriverRoutineResult> {
      unsupportedCall();
    },
    async *stream<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncGenerator<Row> {
      assertRoutineUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      signal?.throwIfAborted();
      const prepared = materialize(rendered, binding);
      const statement = database.prepare(prepared.text);
      configureIntegerMode(statement, integerMode);
      if (!statement.iterate) throw new Error("BRAID_STREAM_UNSUPPORTED: SQLite statement does not expose iteration.");
      if (resultColumns(statement).length === 0) throw new Error("BRAID_RESULT_KIND: SQLite stream requires a row-producing statement.");
      const iterator = statement.iterate(...prepared.values);
      let failed = false;
      let readError: unknown;
      try {
        while (true) {
          signal?.throwIfAborted();
          const next = iterator.next();
          if (next.done) break;
          yield plainRow(next.value) as Row;
        }
      } catch (error) {
        failed = true;
        readError = error;
        throw error;
      } finally {
        try {
          iterator.return?.();
        } catch (cause) {
          const cleanup = Object.assign(new Error("SQLite iterator cleanup failed.", { cause }), {
            code: "BRAID_RESOURCE_CLEANUP",
          });
          if (failed) throw new AggregateError([readError, cleanup], "SQLite read and cleanup failed.", { cause: readError });
          throw cleanup;
        }
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

export function createNodeSqliteDatabase(database: SqliteDatabaseLike, options: SqliteDatabaseOptions = {}) {
  const { integerMode, ...databaseOptions } = options;
  return createDatabase(createNodeSqliteExecutor(database, { integerMode }), databaseOptions);
}
