import type {
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedQuery,
  TypePolicy,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface PgFieldLike {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number;
  readonly fields?: readonly PgFieldLike[];
  readonly command?: string;
}

export interface PgClientLike {
  query(config: { readonly text: string; readonly values: readonly unknown[] }): Promise<PgResultLike>;
  query(text: string, values?: readonly unknown[]): Promise<PgResultLike>;
  release?(): void;
}

export interface PgPoolClientLike extends Omit<PgClientLike, "release"> {
  release(destroy?: boolean): void | Promise<void>;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

export type PgDatabaseOptions = DatabaseOptions & { readonly typePolicy?: TypePolicy };

const oidTypes: Readonly<Record<number, string>> = { 20: "int8", 21: "int2", 23: "int4", 16: "bool", 25: "text", 1700: "numeric" };

function plainRow(value: unknown, fields: readonly PgFieldLike[], policy: TypePolicy): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  const row: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const field = fields.find((candidate) => candidate.name === key);
    const databaseType = field?.dataType ?? (field?.dataTypeID === undefined ? undefined : oidTypes[field.dataTypeID]);
    row[key] = databaseType ? policy.decode(databaseType, entry) : entry;
  }
  return row;
}

function assertUniqueFields(fields: readonly PgFieldLike[]): void {
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate PostgreSQL result label ${field.name}.`);
    names.add(field.name);
  }
}

export function createPgExecutor(client: PgClientLike, options: { readonly typePolicy?: TypePolicy } = {}): QueryExecutor {
  const policy = options.typePolicy ?? defaultTypePolicy;
  const runControl = async (text: string): Promise<void> => { await client.query({ text, values: [] }); };
  return {
    ownershipKey: client,
    async query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>> {
      const result = await client.query({ text: rendered.text, values: rendered.values });
      assertUniqueFields(result.fields ?? []);
      const rows = result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
      const rowBearing = (result.fields?.length ?? 0) > 0 || result.rows.length > 0 || result.command === "SELECT";
      return rowBearing ? { rows: rows as readonly Row[], rowCount: result.rowCount, kind: "rows" } : { rows: [], rowCount: result.rowCount, kind: "command", command: { affectedRows: result.rowCount } };
    },
    async call<Row>(rendered: RenderedQuery) {
      const result = await client.query({ text: rendered.text, values: rendered.values });
      assertUniqueFields(result.fields ?? []);
      const rows = result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
      return { output: {}, resultSets: [{ rows: rows as readonly Row[] }] };
    },
    begin: () => runControl("BEGIN"),
    commit: () => runControl("COMMIT"),
    rollback: () => runControl("ROLLBACK"),
    savepoint: (name) => runControl(`SAVEPOINT ${name}`),
    rollbackTo: (name) => runControl(`ROLLBACK TO SAVEPOINT ${name}`),
    releaseSavepoint: (name) => runControl(`RELEASE SAVEPOINT ${name}`),
  };
}

export function createPgDatabase(client: PgClientLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createDatabase(createPgExecutor(client, { typePolicy }), databaseOptions);
}

export function createPgPoolProvider(pool: PgPoolLike, options: { readonly typePolicy?: TypePolicy } = {}): ConnectionProvider {
  return {
    async acquire(): Promise<ConnectionLease> {
      const client = await pool.connect();
      const executor = createPgExecutor(client, options);
      let released = false;
      return {
        ...executor,
        async release(releaseOptions = {}): Promise<void> {
          if (released) return;
          released = true;
          if (releaseOptions.discard === true) await client.release(true);
          else await client.release();
        },
      };
    },
  };
}

export function createPgPoolDatabase(pool: PgPoolLike, options: PgDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createPooledDatabase(createPgPoolProvider(pool, { typePolicy }), databaseOptions);
}
