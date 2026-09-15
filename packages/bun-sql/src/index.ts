import {
  createBulkBindingDescription,
  createRenderedBulk,
  createRenderedStatement,
  createStatementBindingDescription,
  normalizeExactInteger,
  ResultExactnessError,
  safeDatabaseCount,
  UnsupportedFeatureError,

  type BulkExecutionResult,
  type BulkBindingDescription,
  type CommandResult,
  type ConnectionLease,
  type ConnectionProvider,
  type Database,
  type DatabaseOptions,
  type DriverEnvironment,
  type EnvironmentCapability,
  type ExecutionOptions,
  type QueryExecutionResult,
  type QueryExecutor,
  type RenderedBulk,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingDescription,
  type TransactionIsolation,
  type TransactionOptions,
} from "@sqlbraid/core";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import { representationProfileFor } from "./type-policy.js";

/** The physical dialect selected by the application, not inferred by this adapter. */
export type BunSqlDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

export interface BunSqlClient {
  <T = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<T>;
  unsafe<T = unknown>(text: string, values?: readonly unknown[]): PromiseLike<T>;
  reserve?: () => Promise<BunSqlReservedClient>;
  close?: (options?: { readonly timeout?: number }) => Promise<void>;
  readonly options?: { readonly bigint?: boolean; readonly prepare?: boolean; readonly adapter?: string };
}

export interface BunSqlReservedClient extends BunSqlClient {
  release(): void | Promise<void>;
}

export interface BunSqlDatabaseOptions extends DatabaseOptions {
  readonly dialect: BunSqlDialect;
}

const PRODUCT: Record<BunSqlDialect, string> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
};

function capability(
  status: EnvironmentCapability["status"],
  canonical?: EnvironmentCapability["canonical"],
  rawRepresentations?: readonly string[],
  conditionCode?: string,
): EnvironmentCapability {
  return Object.freeze({
    status,
    ...(canonical === undefined ? {} : { canonical }),
    ...(rawRepresentations === undefined ? {} : { rawRepresentations }),
    ...(conditionCode === undefined ? {} : { conditionCode }),
  });
}

function capabilitiesFor(dialect: BunSqlDialect): Readonly<Record<string, EnvironmentCapability>> {
  const mysqlTransport = dialect === "mysql" || dialect === "mariadb";
  const jsonText = dialect === "sqlite" || dialect === "mariadb";
  const json = jsonText
    ? capability("unsupported", undefined, ["string"])
    : capability("guarded", undefined, ["object", "array"], "bun-sql.json-parser-profile");
  const result: Record<string, EnvironmentCapability> = {
    "sql.native-transparency": capability("guaranteed"),
    "sql.generated-structure": capability("guaranteed"),
    "result.rows": dialect === "mysql" || dialect === "mariadb"
      ? capability("guarded", undefined, undefined, "bun-sql.result-kind-metadata")
      : dialect === "sqlite" ? capability("guarded", undefined, undefined, "bun-sql.sqlite-result-parser") : capability("guaranteed"),
    "result.command": dialect === "mysql" || dialect === "mariadb"
      ? capability("guarded", undefined, undefined, "bun-sql.result-kind-metadata")
      : dialect === "sqlite" ? capability("guarded", undefined, undefined, "bun-sql.sqlite-result-parser") : capability("guaranteed"),
    "result.multiple-sets": capability("unsupported"),
    "result.standard-schema": capability("guaranteed"),
    "numeric.exact-integer": capability("guarded", "string", ["number", "string", "bigint"], "bun-sql.integer-width-profile"),
    "numeric.exact-decimal": dialect === "postgres"
      ? capability("guaranteed", "string", ["string"])
      : capability("unsupported", "string", mysqlTransport ? ["Uint8Array"] : ["number"]),
    "numeric.approximate-float": capability("guarded", "number", ["number"], "bun-sql.float-profile"),
    "numeric.approximate-special": capability("guarded", "number", ["number"], "bun-sql.float-profile"),
    "numeric.bind-exact": capability("guarded", "string", ["string", "number", "bigint"], "bun-sql.numeric-bind-profile"),
    "numeric.command-metadata": capability("guarded", "number", ["number", "bigint"], "bun-sql.command-count-profile"),
    "data.json-parsed": json,
    "data.json-lossless-text": capability(jsonText ? "guaranteed" : "unsupported", jsonText ? "string" : undefined, jsonText ? ["string"] : undefined),
    "data.binary": capability(mysqlTransport ? "unsupported" : "guaranteed", "Uint8Array", ["Uint8Array"]),
    "data.temporal-native": dialect === "sqlite"
      ? capability("unsupported", undefined, ["string"])
      : capability("guarded", undefined, ["Date", "string"], "bun-sql.temporal-profile"),
    "data.temporal-lossless": capability(dialect === "sqlite" ? "guaranteed" : "unsupported", dialect === "sqlite" ? "string" : undefined, dialect === "sqlite" ? ["string"] : undefined),
    "data.timezone": dialect === "sqlite"
      ? capability("unsupported", undefined, ["string"])
      : capability("guarded", undefined, ["Date"], "bun-sql.timezone-profile"),
    "metadata.command-safe": capability("guarded", "number", ["number", "bigint"], "bun-sql.command-count-profile"),
    "dml.insert-returning": capability(dialect === "postgres" || dialect === "sqlite" ? "guaranteed" : "unsupported"),
    "dml.update-returning": capability(dialect === "postgres" || dialect === "sqlite" ? "guaranteed" : "unsupported"),
    "dml.delete-returning": capability(dialect === "postgres" || dialect === "sqlite" ? "guaranteed" : "unsupported"),
    "session.pinned": capability("guaranteed"),
    "statement.prepare": capability("guaranteed"),
    "statement.cancel": capability("unsupported", undefined, ["Query.cancel"]),
    "statement.stream": capability("unsupported"),
    "statement.bulk": capability("guaranteed", undefined, ["prepared-loop"]),
    "execution.bulk-fidelity": capability("guarded", undefined, ["prepared-loop"], "bun-sql.bulk-profile"),
    "transaction": capability("guaranteed"),
    "transaction.savepoint": capability("guaranteed"),
    "transaction.read-only": capability(dialect === "sqlite" ? "unsupported" : "guarded", undefined, undefined, dialect === "sqlite" ? undefined : "bun-sql.transaction-options"),
    "transaction.isolation.read-uncommitted": capability(dialect === "sqlite" ? "unsupported" : "guarded", undefined, undefined, dialect === "sqlite" ? undefined : "bun-sql.transaction-options"),
    "transaction.isolation.read-committed": capability(dialect === "sqlite" ? "unsupported" : "guarded", undefined, undefined, dialect === "sqlite" ? undefined : "bun-sql.transaction-options"),
    "transaction.isolation.repeatable-read": capability(dialect === "sqlite" ? "unsupported" : "guarded", undefined, undefined, dialect === "sqlite" ? undefined : "bun-sql.transaction-options"),
    "transaction.isolation.serializable": dialect === "sqlite"
      ? capability("guaranteed")
      : capability("guarded", undefined, undefined, "bun-sql.transaction-options"),
    "routine.call": capability("unsupported"),
    "routine.out": capability("unsupported"),
    "routine.inout": capability("unsupported"),
    "routine.result-sets": capability("unsupported"),
    "routine.out-cursor": capability("unsupported"),
    "routine.return-value": capability("unsupported"),
  };
  return Object.freeze(result);
}

function unsupported(feature: string, code: `BRAID_${string}`, message: string): never {
  throw new UnsupportedFeatureError(feature, code, message);
}

function assertDialect(statement: RenderedStatement, dialect: BunSqlDialect): void {
  if (statement.dialectId !== dialect) {
    unsupported("dialect", "BRAID_DIALECT_MISMATCH", `Rendered dialect ${JSON.stringify(statement.dialectId)} does not match Bun.SQL dialect ${JSON.stringify(dialect)}.`);
  }
}

function assertValues(values: readonly unknown[]): void {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === undefined) throw new TypeError(`BRAID_BIND_UNDEFINED: parameter ${index + 1} is undefined; use null for SQL NULL.`);
  }
}

function literal(value: unknown): string | undefined {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    try {
      return `'${Date.prototype.toISOString.call(value).replaceAll("'", "''")}'`;
    } catch {
      return undefined;
    }
  }
  if (value instanceof Uint8Array) {
    const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `X'${hex}'`;
  }
  return undefined;
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const synthesizedTemplates = new Map<string, TemplateStringsArray>();
const MAX_SYNTHESIZED_TEMPLATES = 64;
const ROW_COMMANDS = new Set(["SELECT", "SHOW", "DESCRIBE", "EXPLAIN"]);
const DML_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

function assertNativeValue(value: unknown, index: number): void {
  if (Array.isArray(value)) {
    throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is an ambiguous Bun.SQL array value; SQLBraid parameters must be value-only.`);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is an invalid Date.`);
    return;
  }
  if (value instanceof Uint8Array) return;
  if (typeof value !== "object") {
    throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is not a Bun.SQL scalar value.`);
  }
  const candidate = value as {
    readonly value?: unknown;
    readonly columns?: unknown;
    readonly serializedValues?: unknown;
    readonly arrayType?: unknown;
  };
  const helper = Object.hasOwn(candidate, "value")
    && Object.hasOwn(candidate, "columns")
    && Array.isArray(candidate.columns);
  const arrayHelper = Object.hasOwn(candidate, "serializedValues")
    && Object.hasOwn(candidate, "arrayType")
    && typeof candidate.serializedValues === "string"
    && (typeof candidate.arrayType === "string" || typeof candidate.arrayType === "number");
  if (helper || arrayHelper) {
    throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is a Bun.SQL structural helper; SQLBraid parameters must be value-only.`);
  }
  let prototype: object | null = value;
  while (prototype !== null) {
    const then = Object.getOwnPropertyDescriptor(prototype, "then");
    if (then !== undefined && typeof then.value === "function") {
      throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is a Bun.SQL query or fragment; SQLBraid parameters must be value-only.`);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  throw new TypeError(`BRAID_BIND_VALUE_UNSUPPORTED: parameter ${index + 1} is an ambiguous Bun.SQL object value; bind a scalar, Date, Uint8Array, or explicit text instead.`);
}

function assertNativeValues(values: readonly unknown[]): void {
  for (let index = 0; index < values.length; index += 1) assertNativeValue(values[index], index);
}

function nativeTemplate(rendered: RenderedStatement): TemplateStringsArray {
  if (rendered.nativeTemplate !== undefined) return rendered.nativeTemplate;
  const shape = `${rendered.dialectId}:${JSON.stringify(rendered.segments)}`;
  const cached = synthesizedTemplates.get(shape);
  if (cached !== undefined) return cached;
  const cooked = [...rendered.segments] as string[] & { raw: readonly string[] };
  const raw = Object.freeze([...rendered.segments]);
  Object.defineProperty(cooked, "raw", {
    configurable: false,
    enumerable: false,
    value: raw,
    writable: false,
  });
  const template = Object.freeze(cooked) as unknown as TemplateStringsArray;
  if (synthesizedTemplates.size >= MAX_SYNTHESIZED_TEMPLATES) {
    const first = synthesizedTemplates.keys().next().value;
    if (first !== undefined) synthesizedTemplates.delete(first);
  }
  synthesizedTemplates.set(shape, template);
  return template;
}

function bindingAdapter(dialect: BunSqlDialect, client: BunSqlClient): StatementBindingAdapter {
  const id = `bun-sql:${dialect}`;
  const describe = (statement: RenderedStatement, context: { readonly dialectId: string; readonly requestedReuse: "auto" | "simple" | "reuse"; readonly preparedName?: string; readonly transactionScoped?: boolean }): StatementBindingDescription => {
    const logical = createRenderedStatement(statement);
    assertDialect(logical, dialect);
    assertStatementSupported(logical, dialect);
    const values = logical.parameters.map((parameter) => parameter.value);
    assertValues(values);
    assertNativeValues(values);
    const description = createStatementBindingDescription(logical, context, {
      adapterId: id,
      transport: "native-value-template",
      reuse: {
        effective: client.options?.prepare === false ? "simple" : "reuse",
        owner: "driver",
      },
      formatLiteral: (parameter) => literal(parameter.value),
    });
    describedStatements.set(description, logical);
    return description;
  };
  return Object.freeze({
    id,
    describe,
    describeBulk: (bulk: RenderedBulk, context: { readonly dialectId: string; readonly requestedReuse: "auto" | "simple" | "reuse"; readonly preparedName?: string; readonly transactionScoped?: boolean }) => {
      const logical = createRenderedBulk(bulk);
      assertDialect(logical.statement, dialect);
      assertStatementSupported(logical.statement, dialect);
      if (logical.statement.resultKind !== "command") {
        throw new Error("BRAID_BULK_SHAPE: Bun.SQL bulk requires command queries.");
      }
      for (const values of logical.parameterSets) {
        if (values.length !== logical.statement.parameters.length) throw new Error("BRAID_BULK_SHAPE: Bun.SQL bulk parameter cardinality changed.");
        assertValues(values);
        assertNativeValues(values);
      }
      const description = createBulkBindingDescription(logical, context, {
        adapterId: id,
        transport: "native-value-template",
        reuse: { effective: client.options?.prepare === false ? "simple" : "reuse", owner: "driver" },
        formatLiteral: (parameter) => literal(parameter.value),
      });
      describedBulks.set(description, bulk);
      return description;
    },
  });
}

function assertStatementSupported(rendered: RenderedStatement, dialect: BunSqlDialect): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) {
    unsupported("routine.call", "BRAID_CALL_UNSUPPORTED", dialect === "mysql" || dialect === "mariadb"
      ? "Bun.SQL requires MySQL OUT parameters to use user-authored session variables and a second SELECT; its public result has no direction or result-set carrier for SQLBraid call normalization."
      : "Bun.SQL exposes no documented routine output carrier or routine result-set metadata for this dialect.");
  }
  for (const parameter of rendered.parameters) {
    if (parameter.hint !== undefined) throw new Error("BRAID_BIND_HINT_UNSUPPORTED: Bun.SQL does not support explicit bind type hints.");
    if (parameter.direction !== undefined && parameter.direction !== "in") {
      unsupported(
        parameter.direction === "inout" ? "routine.inout" : "routine.out",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "Bun.SQL does not expose a proven OUT/INOUT parameter carrier.",
      );
    }
    if (parameter.outputName !== undefined) {
      unsupported("routine.out", "BRAID_CALL_OUT_UNSUPPORTED", "Bun.SQL does not expose a proven output parameter carrier.");
    }
  }
}

function assertExecutionSignal(options: ExecutionOptions | undefined): void {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  if (signal !== undefined) {
    unsupported("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "Bun.SQL Query.cancel is not a verified active cancellation primitive for this adapter; cancellation would otherwise race query completion.");
  }
}

function statementValues(rendered: RenderedStatement): readonly unknown[] {
  const values = rendered.parameters.map((parameter) => parameter.value);
  assertValues(values);
  assertNativeValues(values);
  return values;
}

function assertStatementBinding(
  rendered: RenderedStatement,
  binding: StatementBindingDescription,
  dialect: BunSqlDialect,
): void {
  if (
    binding.adapterId !== `bun-sql:${dialect}`
    || binding.dialectId !== dialect
    || describedStatements.get(binding) !== rendered
  ) {
    throw new TypeError("BRAID_BINDING_IDENTITY: Bun.SQL statement binding belongs to another statement or adapter.");
  }
}

function assertBulkBinding(
  bulk: RenderedBulk,
  binding: BulkBindingDescription,
  dialect: BunSqlDialect,
): void {
  if (
    binding.adapterId !== `bun-sql:${dialect}`
    || binding.dialectId !== dialect
    || describedBulks.get(binding) !== bulk
  ) {
    throw new TypeError("BRAID_BINDING_IDENTITY: Bun.SQL bulk binding belongs to another bulk or adapter.");
  }
}

function commandResult(value: unknown): CommandResult {
  if (value === null || typeof value !== "object") return Object.freeze({});
  const source = value as Record<string, unknown>;
  const candidate = source.affectedRows ?? source.changes ?? source.rowCount ?? source.count;
  const result: Record<string, unknown> = {};
  if (typeof source.command === "string") result.command = source.command;
  if (candidate !== undefined && candidate !== null) result.affectedRows = safeDatabaseCount(candidate);
  const insertId = source.insertId ?? source.lastInsertRowid;
  if (insertId !== undefined && insertId !== null) result.insertId = normalizeExactInteger(insertId);
  return Object.freeze(result) as CommandResult;
}

function hasSqlKeyword(text: string, target: string): boolean {
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (character === "#") {
      const end = text.indexOf("\n", index + 1);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (character === "$") {
      const match = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u)?.[0];
      if (match !== undefined) {
        const end = text.indexOf(match, index + match.length);
        index = end < 0 ? text.length : end + match.length;
        continue;
      }
    }
    if (character === "'" || character === "\"" || character === "`") {
      const quote = character;
      index += 1;
      while (index < text.length) {
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (text[index] === "\\" && quote === "'" && index + 1 < text.length) index += 2;
        else index += 1;
      }
      continue;
    }
    if (character === "[") {
      const end = text.indexOf("]", index + 1);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (/[A-Za-z]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$]/u.test(text[index]!)) index += 1;
      if (text.slice(start, index).toUpperCase() === target) return true;
      continue;
    }
    index += 1;
  }
  return false;
}

function returnsRows(value: unknown, text: string): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const command = typeof (value as { readonly command?: unknown }).command === "string"
    ? String((value as { readonly command?: unknown }).command).toUpperCase()
    : undefined;
  if (command === undefined) {
    const affectedRows = (value as { readonly affectedRows?: unknown }).affectedRows;
    const insertId = (value as { readonly lastInsertRowid?: unknown }).lastInsertRowid;
    if (value.length > 0) return true;
    if ((typeof affectedRows === "number" && affectedRows > 0)
      || (typeof affectedRows === "bigint" && affectedRows > 0n)
      || (typeof insertId === "number" && insertId > 0)
      || (typeof insertId === "bigint" && insertId > 0n)) return false;
    const count = (value as { readonly count?: unknown }).count;
    if ((typeof count === "number" && Number.isSafeInteger(count) && count > 0)
      || (typeof count === "bigint" && count > 0n && count <= BigInt(Number.MAX_SAFE_INTEGER))) return true;
    unsupported("result.rows", "BRAID_RESULT_KIND_AMBIGUOUS", "Bun.SQL returned an array without command metadata or a public row/command result carrier.");
  }
  if (ROW_COMMANDS.has(command)) return true;
  if (DML_COMMANDS.has(command)) {
    if (value.length > 0) return true;
    if (hasSqlKeyword(text, "RETURNING")) {
      unsupported("result.rows", "BRAID_RESULT_KIND_AMBIGUOUS", "Bun.SQL returned zero rows for a DML RETURNING statement without a public row-kind discriminator.");
    }
  }
  if (!ROW_COMMANDS.has(command) && !DML_COMMANDS.has(command)) {
    if (value.length === 0) return false;
    unsupported("result.rows", "BRAID_RESULT_KIND_AMBIGUOUS", `Bun.SQL returned an unknown command metadata marker ${JSON.stringify(command)} with rows.`);
  }
  return false;
}

function normalizeRowValue(value: unknown, dialect: BunSqlDialect): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isInteger(value)) {
    throw new ResultExactnessError("Bun.SQL returned an integral Number without public column type metadata; cast exact values to text.");
  }
  if ((dialect === "mysql" || dialect === "mariadb") && value instanceof Uint8Array) {
    throw new ResultExactnessError("Bun.SQL exposes DECIMAL and binary values as indistinguishable byte arrays; use explicit SQL text or hexadecimal conversion.");
  }
  return value;
}

function normalizeRow(row: unknown, dialect: BunSqlDialect): unknown {
  if (Array.isArray(row)) return Object.freeze(row.map((value) => normalizeRowValue(value, dialect)));
  if (row !== null && typeof row === "object" && !(row instanceof Date) && !(row instanceof Uint8Array)) {
    const normalized = Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, normalizeRowValue(value, dialect)]),
    );
    return Object.freeze(normalized);
  }
  return normalizeRowValue(row, dialect);
}

function createExecutor(
  client: BunSqlClient,
  dialect: BunSqlDialect,
  sharedBinding?: StatementBindingAdapter,
): QueryExecutor {
  const statementBinding = sharedBinding ?? bindingAdapter(dialect, client);
  const policy = representationProfileFor(dialect).typePolicy;
  const descriptor: DriverEnvironment = Object.freeze({
    database: { product: PRODUCT[dialect] },
    driver: { id: "bun-sql", profile: `bun-sql-${dialect}-1.3.14` },
    typePolicy: { id: policy.id, hash: policy.hash },
    capabilities: capabilitiesFor(dialect),
  });
  const run = async <T>(rendered: RenderedStatement, binding: StatementBindingDescription): Promise<T> => {
    assertDialect(rendered, dialect);
    assertStatementSupported(rendered, dialect);
    assertStatementBinding(rendered, binding, dialect);
    const values = statementValues(rendered);
    return client<T>(nativeTemplate(rendered), ...values);
  };
  const executor: QueryExecutor = {
    ownershipKey: client as object,
    statementBinding,
    environment: descriptor,
    async query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Promise<QueryExecutionResult<Row>> {
      assertExecutionSignal(options);
      const effectiveBinding = binding ?? statementBinding.describe(rendered, { dialectId: dialect, requestedReuse: "auto" });
      const raw = await run<unknown>(rendered, effectiveBinding);
      if (returnsRows(raw, rendered.segments.join(""))) {
        const rows = Object.freeze(raw.map((row) => normalizeRow(row, dialect)) as readonly Row[]);
        return Object.freeze({ kind: "rows", rows, rowCount: rows.length });
      }
      const command = commandResult(raw);
      return Object.freeze({ kind: "command", rows: [] as const, rowCount: command.affectedRows, command });
    },
    stream: <Row>(rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions) => {
      assertDialect(rendered, dialect);
      assertExecutionSignal(options);
      assertStatementSupported(rendered, dialect);
      if (binding !== undefined) assertStatementBinding(rendered, binding, dialect);
      return (async function* (): AsyncGenerator<Row> {
        unsupported("statement.stream", "BRAID_STREAM_UNSUPPORTED", "Bun.SQL has no public streaming cursor; SQLResultArray is fully materialized.");
      })();
    },
    call: async (rendered: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions) => {
      assertDialect(rendered, dialect);
      assertExecutionSignal(options);
      assertStatementSupported(rendered, dialect);
      if (binding !== undefined) assertStatementBinding(rendered, binding, dialect);
      unsupported("routine.call", "BRAID_CALL_UNSUPPORTED", dialect === "mysql" || dialect === "mariadb"
        ? "Bun.SQL requires MySQL OUT parameters to use user-authored session variables and a second SELECT; its public result has no direction or result-set carrier for SQLBraid call normalization."
        : "Bun.SQL exposes no documented routine output carrier or routine result-set metadata for this dialect.");
    },
    bulk: async (bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): Promise<BulkExecutionResult> => {
      assertDialect(bulk.statement, dialect);
      assertExecutionSignal(options);
      assertStatementSupported(bulk.statement, dialect);
      assertBulkBinding(bulk, binding, dialect);
      let affectedRows = 0;
      let hasCount = true;
      const template = nativeTemplate(bulk.statement);
      for (let index = 0; index < binding.itemCount; index += 1) {
        assertExecutionSignal(options);
        const values = binding.valuesAt(index);
        assertValues(values);
        assertNativeValues(values);
        const raw = await client<unknown>(template, ...values);
        const command = commandResult(raw);
        if (command.affectedRows === undefined) hasCount = false;
        else affectedRows += command.affectedRows;
      }
      return Object.freeze({ inputCount: binding.itemCount, ...(hasCount ? { affectedRows } : {}), executionMode: "prepared-loop" });
    },
    begin: async (options?: TransactionOptions): Promise<void> => {
      for (const beginText of transactionBegin(dialect, options)) {
        await client.unsafe(beginText, []);
      }
    },
    commit: async (): Promise<void> => { await client.unsafe("COMMIT", []); },
    rollback: async (): Promise<void> => { await client.unsafe("ROLLBACK", []); },
    savepoint: async (name: string): Promise<void> => { await client.unsafe(`SAVEPOINT ${safeSavepoint(name)}`, []); },
    rollbackTo: async (name: string): Promise<void> => { await client.unsafe(`ROLLBACK TO SAVEPOINT ${safeSavepoint(name)}`, []); },
    releaseSavepoint: async (name: string): Promise<void> => { await client.unsafe(`RELEASE SAVEPOINT ${safeSavepoint(name)}`, []); },
  };
  return executor;
}

function transactionBegin(dialect: BunSqlDialect, options?: TransactionOptions): readonly string[] {
  validateTransactionOptions(options);
  if (dialect === "sqlite") {
    if (options?.readOnly === true) unsupported("transaction.read-only", "BRAID_TX_OPTION_UNSUPPORTED", "Bun.SQL SQLite does not expose read-only transaction options.");
    if (options?.isolation !== undefined && options.isolation !== "serializable") {
      unsupported(`transaction.isolation.${options.isolation}`, "BRAID_TX_OPTION_UNSUPPORTED", "Bun.SQL SQLite only supports the standard serializable isolation contract, which is its ordinary BEGIN behavior.");
    }
    return ["BEGIN"];
  }
  const isolation: Record<TransactionIsolation, string> = {
    "read-uncommitted": "READ UNCOMMITTED",
    "read-committed": "READ COMMITTED",
    "repeatable-read": "REPEATABLE READ",
    serializable: "SERIALIZABLE",
  };
  if (dialect === "postgres") {
    const clauses = ["BEGIN"];
    if (options?.isolation !== undefined) clauses.push(`ISOLATION LEVEL ${isolation[options.isolation]}`);
    if (options?.readOnly === true) clauses.push("READ ONLY");
    return [clauses.join(" ")];
  }
  const statements: string[] = [];
  if (options?.isolation !== undefined) statements.push(`SET TRANSACTION ISOLATION LEVEL ${isolation[options.isolation]}`);
  statements.push(`START TRANSACTION${options?.readOnly === true ? " READ ONLY" : ""}`);
  return statements;
}

function validateTransactionOptions(options: TransactionOptions | undefined): void {
  if (options === undefined) return;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    const error = new TypeError("Transaction options must be an object.");
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
  for (const key of Object.keys(options)) {
    if (key !== "isolation" && key !== "readOnly") {
      const error = new TypeError(`Unsupported transaction option: ${key}.`);
      Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
      throw error;
    }
  }
  if (
    options.isolation !== undefined
    && options.isolation !== "read-uncommitted"
    && options.isolation !== "read-committed"
    && options.isolation !== "repeatable-read"
    && options.isolation !== "serializable"
  ) {
    const error = new TypeError("Transaction isolation must be one of the standard SQLBraid isolation levels.");
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
  if (options.readOnly !== undefined && typeof options.readOnly !== "boolean") {
    const error = new TypeError("Transaction readOnly must be a boolean.");
    Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
    throw error;
  }
}

function safeSavepoint(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new TypeError("Invalid savepoint name.");
  return name;
}

function createProvider(client: BunSqlClient, dialect: BunSqlDialect): ConnectionProvider {
  if (typeof client.reserve !== "function") {
    throw new TypeError("Bun.SQL client does not expose the documented reserve() pool primitive.");
  }
  const statementBinding = bindingAdapter(dialect, client);
  const environment = createExecutor(client, dialect).environment;
  return Object.freeze({
    statementBinding,
    environment,
    acquire: async (): Promise<ConnectionLease> => {
      const reserved = await client.reserve!();
      const executor = createExecutor(reserved, dialect, statementBinding);
      let released = false;
      let terminalFailure: UnsupportedFeatureError | undefined;
      return Object.freeze({
        ...executor,
        release: async (releaseOptions?: { readonly discard?: boolean }): Promise<void> => {
          if (terminalFailure !== undefined) throw terminalFailure;
          if (released) return;
          released = true;
          if (releaseOptions?.discard === true) {
            terminalFailure = new UnsupportedFeatureError(
              "resource.discard",
              "BRAID_RESOURCE_CLEANUP",
              "Bun.SQL reserved connections expose release() but no scoped discard primitive; close the owning Bun.SQL client to discard this reservation.",
            );
            throw terminalFailure;
          }
          try {
            await reserved.release();
          } catch (error) {
            terminalFailure = new UnsupportedFeatureError("resource.cleanup", "BRAID_RESOURCE_CLEANUP", "Bun.SQL reserved connection release failed.", { cause: error });
            throw terminalFailure;
          }
        },
      });
    },
  });
}

export function createBunSqlProvider(client: BunSqlClient, options: BunSqlDatabaseOptions): ConnectionProvider {
  return createProvider(client, options.dialect);
}

export function createBunSqlDatabase(client: BunSqlClient, options: BunSqlDatabaseOptions): Database {
  if (options.dialect === "sqlite") return createDatabase(createExecutor(client, options.dialect), options);
  return createPooledDatabase(createProvider(client, options.dialect), options);
}

export {
  BUN_SQL_MARIADB,
  BUN_SQL_MYSQL,
  BUN_SQL_POSTGRES,
  BUN_SQLITE,
  representationProfiles,
  representationProfileFor,
} from "./type-policy.js";
