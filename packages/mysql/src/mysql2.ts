import type {
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedStatement,
  RoutineCallResult,
  TypePolicy,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface Mysql2FieldLike {
  readonly name?: string;
  readonly type?: string | number;
}

export interface Mysql2ResultHeader extends CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint | string;
  readonly warningStatus?: number;
}

type Mysql2TypedParameter = { readonly type: number; readonly value: unknown; readonly unsigned: boolean };
type Mysql2Parameter = string | number | bigint | boolean | Date | null | Blob | Uint8Array | Mysql2TypedParameter | Mysql2Parameter[] | { [key: string]: Mysql2Parameter };

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: Mysql2Parameter): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  query?(sql: string): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
}

export interface Mysql2PoolConnectionLike extends Mysql2ConnectionLike {
  release(): void | Promise<void>;
  destroy(): void;
}

export interface Mysql2PoolLike {
  getConnection(): Promise<Mysql2PoolConnectionLike>;
}

export type Mysql2DatabaseOptions = DatabaseOptions & { readonly typePolicy?: TypePolicy };

const mysqlTypes: Readonly<Record<number, string>> = { 3: "INT", 8: "BIGINT", 246: "DECIMAL", 253: "VARCHAR", 245: "JSON" };

function assertMysql2Connection(connection: Mysql2ConnectionLike): void {
  const candidate = connection as unknown as { readonly getConnection?: unknown };
  if (
    !connection
    || typeof connection !== "object"
    || typeof connection.execute !== "function"
    || typeof connection.beginTransaction !== "function"
    || typeof connection.commit !== "function"
    || typeof connection.rollback !== "function"
    || typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid MySQL direct adapter requires a physical mysql2 Promise Connection.");
  }
}

function plainRow(value: unknown, fields: readonly Mysql2FieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType = typeof field?.type === "number" ? mysqlTypes[field.type] : field?.type;
    row[key] = databaseType ? policy.decode(databaseType, entry) : entry;
  }
  return row;
}

function assertUniqueFields(fields: readonly Mysql2FieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (!field.name) continue;
    if (names.has(field.name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate MySQL result label ${field.name}.`);
    names.add(field.name);
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: MySQL adapter does not support explicit bind type hints.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();

export const mysql2StatementBinding: StatementBindingAdapter = Object.freeze({
  id: "mysql2",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "mysql2",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "mysql",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? mysql2StatementBinding.describe(statement, defaultBindingContext);
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: MySQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MySQL binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

export function createMysql2Executor(connection: Mysql2ConnectionLike, options: { readonly typePolicy?: TypePolicy } = {}): QueryExecutor {
  assertMysql2Connection(connection);
  const policy = options.typePolicy ?? defaultTypePolicy;
  const control = async (sql: string): Promise<void> => { await (connection.query ?? connection.execute).call(connection, sql); };
  return {
    ownershipKey: connection,
    statementBinding: mysql2StatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await connection.execute(prepared.text, prepared.values as unknown as Mysql2Parameter[]);
      const fields = Array.isArray(rawFields) ? rawFields : [];
      assertUniqueFields(fields);
      if (Array.isArray(payload)) {
        const rows = payload.map((row) => plainRow(row, fields ?? [], policy));
        return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
      }
      if (!payload || typeof payload !== "object") return { rows: [], rowCount: 0, kind: "command", command: {} };
      const header: Mysql2ResultHeader = { ...payload };
      return { rows: [], rowCount: header.affectedRows, kind: "command", command: header };
    },
    async call<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<RoutineCallResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const [payload, rawFields] = await connection.execute(prepared.text, prepared.values as unknown as Mysql2Parameter[]);
      const fields = Array.isArray(rawFields) ? rawFields : [];
      assertUniqueFields(fields);
      if (!Array.isArray(payload)) return { output: payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload)) : {}, resultSets: [] };
      const resultSets = payload.every((entry) => Array.isArray(entry))
        ? payload.map((entry) => ({ rows: entry.map((row) => plainRow(row, fields, policy)) as readonly Row[] }))
        : [{ rows: payload.map((row) => plainRow(row, fields, policy)) as readonly Row[] }];
      return { output: {}, resultSets };
    },
    begin: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${name}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createMysql2Database(connection: Mysql2ConnectionLike, options: Mysql2DatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createDatabase(createMysql2Executor(connection, { typePolicy }), databaseOptions);
}

export function createMysql2PoolProvider(pool: Mysql2PoolLike, options: { readonly typePolicy?: TypePolicy } = {}): ConnectionProvider {
  return {
    statementBinding: mysql2StatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      const executor = createMysql2Executor(connection, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) connection.destroy();
          else await connection.release();
        },
      };
    },
  };
}

export function createMysql2PoolDatabase(pool: Mysql2PoolLike, options: Mysql2DatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createPooledDatabase(createMysql2PoolProvider(pool, { typePolicy }), databaseOptions);
}
