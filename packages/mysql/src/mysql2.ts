import type { CommandResult, QueryExecutor, QueryExecutionResult, RenderedQuery, RoutineCallResult, TypePolicy } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
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

export interface Mysql2ConnectionLike {
  execute(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  query?(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, readonly Mysql2FieldLike[] | undefined]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

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
  const control = async (sql: string): Promise<void> => { await (connection.query ?? connection.execute).call(connection, sql, []); };
  return {
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const [payload, rawFields] = await connection.execute(rendered.text, rendered.values);
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
      const [payload, rawFields] = await connection.execute(rendered.text, rendered.values);
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

export function createMysql2Database(connection: Mysql2ConnectionLike, options: { readonly typePolicy?: TypePolicy } = {}) {
  return createDatabase(createMysql2Executor(connection, options));
}
