import type {
  ConnectionLease,
  ConnectionProvider,
  DatabaseOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedStatement,
  TypePolicy,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { createRenderedStatement, createStatementBindingDescription } from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { typePolicy as defaultTypePolicy } from "./type-policy.js";

export interface PgFieldLike {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
  readonly fields?: readonly PgFieldLike[];
  readonly command?: string;
}

export interface PgClientLike {
  query(config: { readonly text: string; readonly values: readonly unknown[] }): Promise<PgResultLike>;
  query(text: string, values?: readonly unknown[]): Promise<PgResultLike>;
  /**
   * Physical node-postgres clients expose these helpers; pools do not.
   * They are the public discriminator that keeps pool usage on the lease API.
   */
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
}

export interface PgPoolClientLike extends PgClientLike {
  release(destroy?: boolean): void | Promise<void>;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

export type PgDatabaseOptions = DatabaseOptions & { readonly typePolicy?: TypePolicy };

const oidTypes: Readonly<Record<number, string>> = { 20: "int8", 21: "int2", 23: "int4", 16: "bool", 25: "text", 1700: "numeric" };

function assertPgClient(client: PgClientLike): void {
  if (!client || typeof client !== "object" || typeof client.escapeIdentifier !== "function" || typeof client.escapeLiteral !== "function") {
    throw new TypeError("SQLBraid PostgreSQL direct adapter requires a physical pg Client or PoolClient.");
  }
}

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

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new Error("BRAID_BIND_HINT_UNSUPPORTED: PostgreSQL adapter does not support explicit bind type hints.");
  }
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();

export const pgStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "pg",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "pg",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "postgres",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description = binding ?? pgStatementBinding.describe(statement, defaultBindingContext);
  if (describedStatements.get(description) !== statement) throw new TypeError("BRAID_BINDING_IDENTITY: PostgreSQL description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: PostgreSQL binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

export function createPgExecutor(client: PgClientLike, options: { readonly typePolicy?: TypePolicy } = {}): QueryExecutor {
  assertPgClient(client);
  const policy = options.typePolicy ?? defaultTypePolicy;
  const runControl = async (text: string): Promise<void> => { await client.query({ text, values: [] }); };
  return {
    ownershipKey: client,
    statementBinding: pgStatementBinding,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      const result = await client.query(materialize(rendered, binding));
      assertUniqueFields(result.fields ?? []);
      const rows = result.rows.map((row) => plainRow(row, result.fields ?? [], policy));
      const rowCount = result.rowCount ?? undefined;
      const rowBearing = (result.fields?.length ?? 0) > 0 || result.rows.length > 0 || result.command === "SELECT";
      return rowBearing ? { rows: rows as readonly Row[], rowCount, kind: "rows" } : { rows: [], rowCount, kind: "command", command: { affectedRows: rowCount } };
    },
    async call<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription) {
      assertParameterHintsUnsupported(rendered);
      const result = await client.query(materialize(rendered, binding));
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
    statementBinding: pgStatementBinding,
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
