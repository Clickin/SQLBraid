import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DatabaseOptions,
  DriverRoutineResult,
  DriverEnvironment,
  ExecutionOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
} from "@sqlbraid/core";
import {
  AdapterError,
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  normalizeExactInteger,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import { preparePositionalResultProjector } from "@sqlbraid/core/driver";
import { createDatabase } from "@sqlbraid/runtime";
import { typePolicy } from "./type-policy.js";

/** D1 metadata subset; `last_row_id` is transport-limited and not treated as exact int64 evidence. */
export interface D1ResultMetaLike {
  readonly changes?: number;
  readonly last_row_id?: number;
}

export interface D1ResultLike<Row = unknown> {
  readonly success?: boolean;
  readonly meta?: D1ResultMetaLike;
  readonly changes?: number;
  readonly lastRowId?: number | null;
  readonly results?: readonly Row[] | null;
}

export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  raw(options?: { readonly columnNames?: boolean }): Promise<readonly (readonly unknown[])[]>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<Row = unknown>(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike<Row>[]>;
}

/** Options forwarded to the async D1 facade; D1 does not expose streaming or callback transactions. */
export interface D1DatabaseOptions extends DatabaseOptions {}

function assertRoutineUnsupported(rendered: RenderedStatement): void {
  if (rendered.resultKind === "call" || rendered.routineProcedure !== undefined) {
    throw new UnsupportedFeatureError(
      "routine.call",
      "BRAID_CALL_UNSUPPORTED",
      "Cloudflare D1 does not support routine calls.",
    );
  }
}

function assertRoutineParametersUnsupported(rendered: RenderedStatement): void {
  for (const parameter of rendered.parameters) {
    if (parameter.direction === "inout") {
      throw new UnsupportedFeatureError(
        "routine.inout",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "Cloudflare D1 does not expose a routine INOUT parameter carrier.",
      );
    }
    if (parameter.direction === "out" || parameter.outputName !== undefined) {
      throw new UnsupportedFeatureError(
        "routine.out",
        "BRAID_CALL_OUT_UNSUPPORTED",
        "Cloudflare D1 does not expose a routine OUT parameter carrier.",
      );
    }
  }
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "Cloudflare D1 does not support explicit bind type hints.",
    );
  }
}

function assertCommand(rendered: RenderedStatement): void {
  if (rendered.resultKind !== "command")
    throw new Error("BRAID_BULK_SHAPE: Cloudflare D1 bulk requires command queries.");
  if (rendered.parameters.some((parameter) => (parameter.direction ?? "in") !== "in")) {
    throw new Error("BRAID_BULK_SHAPE: Cloudflare D1 bulk does not support OUT or INOUT parameters.");
  }
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

function assertD1Value(value: unknown): void {
  if (value === null || typeof value === "string") return;
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AdapterError("BRAID_BIND_VALUE_UNSUPPORTED", "D1 binds require finite numbers.");
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new RangeError("BRAID_INTEGER_UNSAFE: D1 cannot safely bind an integer outside JavaScript's safe range.");
    return;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < 256)
  )
    return;
  if (value instanceof ArrayBuffer || isArrayBufferView(value)) return;
  throw new AdapterError(
    "BRAID_BIND_VALUE_UNSUPPORTED",
    "D1 binds support null, strings, booleans, finite numbers, and binary buffers.",
  );
}

function assertD1Values(values: readonly unknown[]): void {
  for (const value of values) assertD1Value(value);
}

function assertExecutionOptions(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal === undefined) return;
  if (signal.aborted) throw signal.reason;
  throw new UnsupportedFeatureError(
    "statement.cancel",
    "BRAID_CANCEL_UNSUPPORTED",
    "Cloudflare D1 does not expose a safe statement cancellation primitive.",
  );
}

function normalizeValue(value: unknown): unknown {
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (isArrayBufferView(value)) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < 256)
  ) {
    return Uint8Array.from(value);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("BRAID_INTEGER_UNSAFE: D1 returned an integer outside JavaScript's safe range.");
    }
    return normalizeExactInteger(value);
  }
  return value;
}

function prepareD1RowProjector(names: readonly string[], rowCountHint?: number) {
  return preparePositionalResultProjector(
    names.map((name, index) => ({ name, index, decode: normalizeValue })),
    rowCountHint,
  );
}

function namesFromRaw(raw: readonly (readonly unknown[])[]): readonly string[] | undefined {
  const header = raw[0];
  if (!header || header.length === 0 || header.some((value) => typeof value !== "string")) return undefined;
  const names = header as readonly string[];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`BRAID_RESULT_COLUMNS: duplicate D1 result label ${name}.`);
    seen.add(name);
  }
  return names;
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();

export const d1StatementBinding: StatementBindingAdapter = Object.freeze({
  id: "cloudflare-d1",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineUnsupported(statement);
    assertRoutineParametersUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    assertD1Values(statement.parameters.map((parameter) => parameter.value));
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "cloudflare-d1",
      transport: "text-positional",
      placeholder: (index) => `?${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertRoutineParametersUnsupported(statement);
    assertCommand(statement);
    assertParameterHintsUnsupported(statement);
    for (const values of bulk.parameterSets) {
      if (values.length !== statement.parameters.length)
        throw new Error("BRAID_BULK_SHAPE: Cloudflare D1 bulk parameter cardinality changed.");
      assertD1Values(values);
    }
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "cloudflare-d1",
      transport: "text-positional",
      placeholder: (index) => `?${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    return description;
  },
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description =
    binding ?? d1StatementBinding.describe(statement, { dialectId: statement.dialectId, requestedReuse: "auto" });
  if (describedStatements.get(description) !== statement)
    throw new TypeError("BRAID_BINDING_IDENTITY: D1 description belongs to another statement or adapter.");
  if (description.parameterizedSql === undefined)
    throw new Error("BRAID_BIND_TRANSPORT: D1 binding description did not provide parameterized SQL.");
  return { text: description.parameterizedSql, values: statement.parameters.map((parameter) => parameter.value) };
}

const d1Environment = Object.freeze<DriverEnvironment>({
  database: { product: "sqlite" },
  driver: { id: "cloudflare-d1", profile: "d1-guarded-safe-integer" },
  typePolicy: { id: typePolicy.id, hash: typePolicy.hash },
  capabilities: {
    "sql.native-transparency": { status: "guaranteed" },
    "numeric.exact-integer": {
      status: "guarded",
      canonical: "string",
      rawRepresentations: ["number"],
      conditionCode: "cloudflare-d1.safe-integer",
    },
    "numeric.approximate-float": {
      status: "guarded",
      canonical: "number",
      rawRepresentations: ["number"],
      conditionCode: "cloudflare-d1.numeric-profile",
    },
    "numeric.bind-exact": {
      status: "guarded",
      canonical: "string",
      rawRepresentations: ["string"],
      conditionCode: "cloudflare-d1.safe-integer",
    },
    "session.pinned": { status: "unsupported", conditionCode: "cloudflare-d1.no-physical-session-pinning" },
    transaction: { status: "unsupported" },
    "transaction.savepoint": { status: "unsupported" },
    "transaction.read-only": { status: "unsupported" },
    "transaction.isolation.read-uncommitted": { status: "unsupported" },
    "transaction.isolation.read-committed": { status: "unsupported" },
    "transaction.isolation.repeatable-read": { status: "unsupported" },
    "transaction.isolation.serializable": { status: "unsupported" },
    "statement.prepare": { status: "guaranteed" },
    "statement.cancel": { status: "unsupported" },
    "statement.stream": { status: "unsupported" },
    "statement.bulk": { status: "guaranteed" },
    "routine.call": { status: "unsupported" },
    "routine.out": { status: "unsupported" },
    "routine.inout": { status: "unsupported" },
    "routine.return-value": { status: "unsupported" },
    "routine.result-sets": { status: "unsupported" },
    "routine.out-cursor": { status: "unsupported" },
  },
  // D1 denies sqlite_version(); unknown server versions stay unreported.
});

/** Wrap a Cloudflare D1 binding; unsupported streaming and transaction features reject explicitly. */
export function createD1Executor(database: D1DatabaseLike): QueryExecutor {
  return {
    ownershipKey: database,
    statementBinding: d1StatementBinding,
    environment: d1Environment,
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const unbound = database.prepare(prepared.text);
      const statement = prepared.values.length > 0 ? unbound.bind(...prepared.values) : unbound;
      // raw({columnNames:true}) is the documented D1 public row/column API. It
      // preserves duplicate labels and includes a header for zero-row SELECTs.
      const raw = await statement.raw({ columnNames: true });
      const names = namesFromRaw(raw);
      if (names === undefined) return { rows: [], kind: "command", command: {} };
      if (raw.length === 1) return { rows: [], rowCount: 0, kind: "rows" };
      const projectRow = prepareD1RowProjector(names, raw.length - 1);
      const rows: Record<string, unknown>[] = [];
      for (let index = 1; index < raw.length; index += 1) rows.push(projectRow(raw[index]!));
      return { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" };
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      options?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      assertExecutionOptions(options);
      assertRoutineParametersUnsupported(bulk.statement);
      if (!binding || describedBulks.get(binding) !== bulk)
        throw new TypeError("BRAID_BINDING_IDENTITY: D1 bulk description belongs to another bulk or adapter.");
      const text = binding.parameterizedSql;
      if (text === undefined)
        throw new Error("BRAID_BIND_TRANSPORT: D1 bulk binding description did not provide parameterized SQL.");
      const canonical = database.prepare(text);
      const statements = bulk.parameterSets.map((_, index) => canonical.bind(...binding.valuesAt(index)));
      const results = await database.batch(statements);
      let affectedRows = 0;
      let hasAffectedRows = false;
      for (const result of results) {
        if (Array.isArray(result.results) && result.results.length > 0) {
          throw new Error("BRAID_BULK_RESULT_KIND: D1 native batch returned rows; bulk requires command statements.");
        }
        const changes = result.meta?.changes ?? result.changes;
        if (changes !== undefined) {
          hasAffectedRows = true;
          affectedRows = safeDatabaseCount(affectedRows + safeDatabaseCount(changes));
        }
      }
      return {
        inputCount: bulk.parameterSets.length,
        ...(hasAffectedRows ? { affectedRows } : {}),
        executionMode: "remote-batch",
      };
    },
    async call(
      rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<DriverRoutineResult> {
      assertExecutionOptions(options);
      assertRoutineUnsupported(rendered);
      assertRoutineParametersUnsupported(rendered);
      throw new UnsupportedFeatureError(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "Cloudflare D1 adapter does not support routine calls.",
      );
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      assertExecutionOptions(options);
      assertRoutineParametersUnsupported(rendered);
      throw new UnsupportedFeatureError(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "Cloudflare D1 has no incremental row cursor API.",
      );
    },
  };
}

/** Wrap a Cloudflare D1 binding as an application database. */
export function createD1Database(database: D1DatabaseLike, options: D1DatabaseOptions = {}) {
  return createDatabase(createD1Executor(database), options);
}
