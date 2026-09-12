import type {
  CommandResult,
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedQuery,
  RoutineCallResult,
  TypePolicy,
} from "@sqlbraid/core";
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
type Mysql2Parameter = string | number | bigint | boolean | Date | null | Blob | Buffer | Uint8Array | Mysql2TypedParameter | Mysql2Parameter[] | { [key: string]: Mysql2Parameter };

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: Mysql2Parameter): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  query?(sql: string): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export interface Mysql2PoolConnectionLike extends Omit<Mysql2ConnectionLike, "release" | "destroy"> {
  release(): void | Promise<void>;
  destroy(): void;
}

export interface Mysql2PoolLike {
  getConnection(): Promise<Mysql2PoolConnectionLike>;
}

export type Mysql2DatabaseOptions = DatabaseOptions & { readonly typePolicy?: TypePolicy };

const mysqlTypes: Readonly<Record<number, string>> = { 3: "INT", 8: "BIGINT", 246: "DECIMAL", 253: "VARCHAR", 245: "JSON" };

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

export function createMysql2Executor(connection: Mysql2ConnectionLike, options: { readonly typePolicy?: TypePolicy } = {}): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const control = async (sql: string): Promise<void> => { await (connection.query ?? connection.execute).call(connection, sql); };
  return {
    ownershipKey: connection,
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      // RenderedQuery values are the driver-owned bind boundary; mysql2 accepts the mutable array shape here.
      const [payload, rawFields] = await connection.execute(rendered.text, rendered.values as unknown as Mysql2Parameter[]);
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
    async call<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>> {
      const [payload, rawFields] = await connection.execute(rendered.text, rendered.values as unknown as Mysql2Parameter[]);
      const fields = Array.isArray(rawFields) ? rawFields : [];
      assertUniqueFields(fields);
      if (!Array.isArray(payload)) return { output: payload && typeof payload === "object" ? Object.fromEntries(Object.entries(payload)) : {}, resultSets: [] };
      const resultSets = payload.every((entry) => Array.isArray(entry))
        ? payload.map((entry) => ({ rows: entry.map((row) => plainRow(row, fields, policy)) as readonly Row[] }))
        : [{ rows: payload.map((row) => plainRow(row, fields, policy)) as readonly Row[] }];
      return { output: {}, resultSets };
    },
    begin: connection.beginTransaction?.bind(connection),
    commit: connection.commit?.bind(connection),
    rollback: connection.rollback?.bind(connection),
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
