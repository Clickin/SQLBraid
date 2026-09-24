import type {
  BulkBindingDescription,
  ConnectionLease,
  ConnectionProvider,
  DriverRoutineResult,
  ExecutionOptions,
  QueryExecutor,
  QueryExecutionResult,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingContext,
  StatementBindingDescription,
  TransactionOptions,
  TypePolicy,
} from "@sqlbraid/core";
import {
  createBulkBindingDescription,
  createRenderedStatement,
  createStatementBindingDescription,
  ResultExactnessError,
  normalizeExactInteger,
  safeDatabaseCount,
  UnsupportedFeatureError,
} from "@sqlbraid/core";
import {
  assertSavepointName,
  createCleanupScope,
  defineResultProperty,
  identityResultValue,
  preparePositionalResultProjector,
} from "@sqlbraid/core/driver";
import { createDatabase, createPooledDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import { mariaDbEnvironment, mariaDbProfile } from "./mariadb/environment.js";
import { fieldTypes } from "./mariadb/types.js";
import type {
  MariaDbCommandResult,
  MariaDbConnectionLike,
  MariaDbDatabaseOptions,
  MariaDbExecutorOptions,
  MariaDbFieldLike,
  MariaDbPoolLike,
  MariaDbRowSet,
  MariaDbStreamLike,
} from "./mariadb/types.js";

export type {
  MariaDbCommandResult,
  MariaDbConnectionLike,
  MariaDbDatabaseOptions,
  MariaDbExecutorOptions,
  MariaDbFieldLike,
  MariaDbParameter,
  MariaDbPoolConnectionLike,
  MariaDbPoolLike,
  MariaDbQueryOptions,
  MariaDbRowSet,
  MariaDbStreamLike,
} from "./mariadb/types.js";

export type {
  MariaDbConnectionOptions,
  MariaDbJsonProfile,
  MariaDbProfileOptions,
  MariaDbRepresentationProfile,
  MariaDbTemporalProfile,
} from "./type-policy.js";
export {
  MARIADB_DATE_TEXT,
  MARIADB_JSON_TEXT,
  MARIADB_LOSSLESS_TEXT,
  MARIADB_NATIVE,
  representationProfiles,
  typePolicyForProfile,
} from "./type-policy.js";

function assertMariaDbConnection(connection: MariaDbConnectionLike): void {
  const candidate = connection as unknown as {
    readonly getConnection?: unknown;
  };
  if (
    !connection ||
    typeof connection !== "object" ||
    typeof connection.execute !== "function" ||
    typeof connection.beginTransaction !== "function" ||
    typeof connection.commit !== "function" ||
    typeof connection.rollback !== "function" ||
    typeof candidate.getConnection === "function"
  ) {
    throw new TypeError("SQLBraid MariaDB direct adapter requires a physical MariaDB Connector/Node.js Connection.");
  }
}

function assertExecutionOptions(connection: MariaDbConnectionLike, options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  if (signal !== undefined && typeof connection.destroy !== "function") {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "MariaDB Connector/Node.js connection does not expose the documented destroy() cancellation primitive.",
    );
  }
}

async function executeWithCancellation<T>(
  connection: MariaDbConnectionLike,
  operation: () => Promise<T>,
  options?: ExecutionOptions,
): Promise<T> {
  assertExecutionOptions(connection, options);
  const signal = options?.signal;
  if (signal === undefined) return operation();
  let aborted = false;
  let destroyFailure: unknown;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    try {
      connection.destroy!();
    } catch (error) {
      destroyFailure = error;
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await operation();
    if (destroyFailure !== undefined) {
      const cleanup = cleanupError("MariaDB cancellation cleanup failed.", destroyFailure);
      throw cleanup;
    }
    if (aborted)
      throw cleanupError(
        "MariaDB cancellation discarded the physical connection.",
        signal.reason ?? new Error("Execution aborted."),
      );
    return result;
  } catch (error) {
    if (destroyFailure !== undefined) {
      throw cleanupAggregate(
        [error, cleanupError("MariaDB cancellation cleanup failed.", destroyFailure)],
        "MariaDB cancellation cleanup failed.",
        error,
      );
    }
    if (aborted) {
      throw cleanupError("MariaDB cancellation discarded the physical connection.", signal.reason ?? error);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cleanupError(message: string, cause?: unknown): Error & { readonly code: string } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function cleanupAggregate(
  errors: readonly unknown[],
  message: string,
  cause?: unknown,
): AggregateError & { readonly code: string } {
  const error = new AggregateError(errors, message, cause === undefined ? undefined : { cause }) as AggregateError & {
    readonly code: string;
  };
  Object.defineProperty(error, "code", { value: "BRAID_RESOURCE_CLEANUP", enumerable: true });
  return error;
}

function databaseType(field: MariaDbFieldLike | undefined): string | undefined {
  if (field?.isDataTypeFormatJson?.()) return "JSON";
  if (typeof field?.type === "string" && field.type.length > 0) {
    const type = field.type.toUpperCase();
    if (type === "TINY") return "TINYINT";
    if (type === "SHORT") return "SMALLINT";
    if (type === "INT24") return "MEDIUMINT";
    if (type === "LONGLONG") return "BIGINT";
    if (type === "NEWDECIMAL") return "DECIMAL";
    if (type === "VAR_STRING" || type === "STRING") return "VARCHAR";
    if (type === "LONG") return "INT";
    return type;
  }
  return field?.columnType === undefined ? undefined : fieldTypes[field.columnType];
}

function fieldsFor(value: unknown): readonly MariaDbFieldLike[] {
  if (!Array.isArray(value)) return [];
  const meta = (value as MariaDbRowSet).meta;
  return Array.isArray(meta) ? meta : [];
}

function isFieldMetadata(value: unknown): value is readonly MariaDbFieldLike[] {
  return (
    Array.isArray(value) &&
    value.every(
      (field) =>
        field !== null && typeof field === "object" && ("name" in field || "type" in field || "columnType" in field),
    )
  );
}

function attachMetadata(rows: readonly unknown[], fields: readonly MariaDbFieldLike[]): MariaDbRowSet {
  Object.defineProperty(rows, "meta", { configurable: true, enumerable: false, value: fields });
  return rows as MariaDbRowSet;
}

function normalizeMetadataResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (
    value.length === 2 &&
    value[0] !== null &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0]) &&
    Array.isArray(value[1]) &&
    value[1].length === 0
  ) {
    return value[0];
  }
  if (
    value.length === 2 &&
    Array.isArray(value[0]) &&
    Array.isArray(value[1]) &&
    value[0].some((entry) => Array.isArray(entry)) &&
    value[1].some((entry) => Array.isArray(entry)) &&
    !isFieldMetadata(value[1])
  ) {
    const rowSets: MariaDbRowSet[] = [];
    const rows = value[0];
    const metadata = value[1];
    for (let index = 0; index < rows.length; index += 1) {
      const rowSet = rows[index];
      const fields = metadata[index];
      if (Array.isArray(rowSet) && isFieldMetadata(fields)) rowSets.push(attachMetadata(rowSet, fields));
    }
    return rowSets;
  }
  if (value.length === 2 && Array.isArray(value[0]) && isFieldMetadata(value[1])) {
    return attachMetadata(value[0], value[1]);
  }
  if (
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && Array.isArray(entry[0]) && isFieldMetadata(entry[1]),
    )
  ) {
    return value.map((entry) => normalizeMetadataResult(entry));
  }
  return value;
}

function assertUniqueFields(fields: readonly MariaDbFieldLike[]): readonly (string | undefined)[] {
  const names = new Set<string>();
  const resolved: (string | undefined)[] = [];
  resolved.length = fields.length;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const name = typeof field.name === "function" ? field.name() : field.name;
    resolved[index] = name;
    if (name === undefined) continue;
    if (names.has(name)) {
      const error = new Error(`BRAID_RESULT_COLUMNS: duplicate MariaDB result label ${name}.`);
      Object.defineProperty(error, "code", { value: "BRAID_RESULT_COLUMNS", enumerable: true });
      throw error;
    }
    names.add(name);
  }
  return resolved;
}

function prepareMariaDbRowProjector(
  fields: readonly MariaDbFieldLike[],
  names: readonly (string | undefined)[],
  policy: TypePolicy,
  rowCountHint?: number,
): (value: unknown) => Record<string, unknown> {
  const columns = fields.flatMap((field, index) => {
    const name = names[index];
    if (name === undefined) return [];
    const type = databaseType(field);
    const validate = prepareMariaDbNumericValidator(type);
    const decode =
      type === undefined
        ? identityResultValue
        : (entry: unknown): unknown => {
            validate(entry);
            return policy.decode(type, entry);
          };
    return [{ name, index, decode }];
  });
  const projectArray = preparePositionalResultProjector(columns, rowCountHint);
  let byName: Map<string, (entry: unknown) => unknown> | undefined;
  return (value): Record<string, unknown> => {
    if (!value || typeof value !== "object") {
      throw new Error("BRAID_RESULT_COLUMNS: MariaDB Connector must return result rows.");
    }
    if (Array.isArray(value)) return projectArray(value);
    byName ??= new Map(columns.map((column) => [column.name, column.decode] as const));
    const row: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineResultProperty(row, key, (byName.get(key) ?? identityResultValue)(entry));
    }
    return row;
  };
}

function prepareMariaDbNumericValidator(databaseTypeName: string | undefined): (value: unknown) => void {
  if (databaseTypeName === undefined) return () => undefined;
  const type = databaseTypeName.toUpperCase();
  if (type === "TINYINT" || type === "SMALLINT" || type === "MEDIUMINT" || type === "INT") {
    return (value) => {
      if (value === null || value === undefined) return;
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
        throw new ResultExactnessError(`MariaDB ${type} result has an unsupported representation.`);
      }
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new ResultExactnessError(`MariaDB ${type} result was an unsafe JavaScript number.`);
      }
    };
  }
  if (type === "DECIMAL" || type === "NEWDECIMAL") {
    return (value) => {
      if (value === null || value === undefined || typeof value === "string") return;
      throw new ResultExactnessError("MariaDB DECIMAL results must remain strings.");
    };
  }
  if (type === "BIGINT" || type === "LONGLONG") {
    return (value) => {
      if (value === null || value === undefined) return;
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new ResultExactnessError("MariaDB BIGINT result was an unsafe JavaScript number.");
      }
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
        throw new ResultExactnessError("MariaDB BIGINT result has an unsupported representation.");
      }
    };
  }
  if (type === "FLOAT" || type === "DOUBLE") {
    return (value) => {
      if (value === null || value === undefined || typeof value === "number") return;
      throw new ResultExactnessError(`MariaDB ${type} result must remain a JavaScript number.`);
    };
  }
  return () => undefined;
}

function assertParameterHintsUnsupported(rendered: RenderedStatement): void {
  if (rendered.parameters.some((parameter) => parameter.hint !== undefined)) {
    throw new UnsupportedFeatureError(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "MariaDB Connector/Node.js does not expose SQLBraid parameter type descriptors.",
    );
  }
}

function assertRoutineOutputsUnsupported(rendered: RenderedStatement): void {
  const output = rendered.parameters.find(
    (parameter) => parameter.direction !== undefined && parameter.direction !== "in",
  );
  const direction = output?.direction;
  if (direction === undefined) return;
  throw new UnsupportedFeatureError(
    direction === "inout" ? "routine.inout" : "routine.out",
    "BRAID_CALL_OUT_UNSUPPORTED",
    "MariaDB Connector/Node.js does not expose a proven public OUT/INOUT carrier discriminator.",
  );
}

function isNestedResultPayload(value: unknown): value is readonly unknown[][] {
  return Array.isArray(value) && !Object.hasOwn(value, "meta") && value.some((entry) => Array.isArray(entry));
}

function resultRows(value: unknown, policy: TypePolicy): QueryExecutionResult<unknown> {
  if (isNestedResultPayload(value)) {
    throw new UnsupportedFeatureError(
      "routine.result-sets",
      "BRAID_RESULT_SETS_UNSUPPORTED",
      "MariaDB returned multiple result sets; use database.call().",
    );
  }
  if (Array.isArray(value)) {
    const fields = fieldsFor(value);
    const names = assertUniqueFields(fields);
    const rows = value.length === 0 ? [] : value.map(prepareMariaDbRowProjector(fields, names, policy, value.length));
    return { rows, rowCount: rows.length, kind: "rows" };
  }
  if (!value || typeof value !== "object") {
    return { rows: [], rowCount: 0, kind: "command", command: {} };
  }
  const rawCommand = { ...value } as MariaDbCommandResult;
  const command: MariaDbCommandResult = {
    ...rawCommand,
    ...(rawCommand.affectedRows === undefined ? {} : { affectedRows: safeDatabaseCount(rawCommand.affectedRows) }),
    ...(rawCommand.insertId === undefined || rawCommand.insertId === null
      ? {}
      : { insertId: normalizeExactInteger(rawCommand.insertId) }),
    ...(rawCommand.warningStatus === undefined ? {} : { warningStatus: safeDatabaseCount(rawCommand.warningStatus) }),
  };
  return {
    rows: [],
    rowCount: command.affectedRows,
    kind: "command",
    command,
  };
}

function affectedRows(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    let total = 0n;
    let found = false;
    for (const item of value) {
      const count = affectedRows(item);
      if (count !== undefined) {
        total += BigInt(count);
        found = true;
      }
    }
    return found ? safeDatabaseCount(total) : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const count = (value as { readonly affectedRows?: unknown }).affectedRows;
  return count === undefined ? undefined : safeDatabaseCount(count);
}

const describedStatements = new WeakMap<StatementBindingDescription, RenderedStatement>();
const describedBulks = new WeakMap<BulkBindingDescription, RenderedBulk>();
const bulkMatrices = new WeakMap<BulkBindingDescription, readonly (readonly unknown[])[]>();

export const mariaDbStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "mariadb",
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription {
    statement = createRenderedStatement(statement);
    assertRoutineOutputsUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "mariadb",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedStatements.set(description, statement);
    return description;
  },
  describeBulk(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription {
    const statement = createRenderedStatement(bulk.statement);
    assertRoutineOutputsUnsupported(statement);
    assertParameterHintsUnsupported(statement);
    const parameterSets = Object.freeze(
      bulk.parameterSets.map((values) => {
        if (!Array.isArray(values) || values.length !== statement.parameters.length) {
          throw new Error(
            "BRAID_BULK_SHAPE: MariaDB bulk parameter sets must match the first rendered statement shape.",
          );
        }
        return Object.freeze([...values]);
      }),
    );
    const description = createBulkBindingDescription(bulk, context, {
      adapterId: "mariadb",
      transport: "text-positional",
      placeholder: () => "?",
      reuse: { effective: "reuse", owner: "driver" },
    });
    describedBulks.set(description, bulk);
    bulkMatrices.set(description, parameterSets);
    return description;
  },
});

const defaultBindingContext: StatementBindingContext = Object.freeze({
  dialectId: "mariadb",
  requestedReuse: "auto",
});

function materialize(
  statement: RenderedStatement,
  binding: StatementBindingDescription | undefined,
): { readonly text: string; readonly values: readonly unknown[] } {
  statement = createRenderedStatement(statement);
  const description =
    binding ??
    mariaDbStatementBinding.describe(statement, {
      dialectId: statement.dialectId,
      requestedReuse: defaultBindingContext.requestedReuse,
    });
  if (describedStatements.get(description) !== statement) {
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB description belongs to another statement or adapter.");
  }
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MariaDB binding description did not provide parameterized SQL.");
  }
  return {
    text: description.parameterizedSql,
    values: statement.parameters.map((parameter) => parameter.value),
  };
}

function materializeBulk(
  bulk: RenderedBulk,
  binding: BulkBindingDescription | undefined,
): { readonly text: string; readonly values: readonly (readonly unknown[])[]; readonly itemCount: number } {
  const statement = createRenderedStatement(bulk.statement);
  assertParameterHintsUnsupported(statement);
  assertRoutineOutputsUnsupported(statement);
  const description =
    binding ??
    mariaDbStatementBinding.describeBulk!(bulk, {
      dialectId: statement.dialectId,
      requestedReuse: defaultBindingContext.requestedReuse,
    });
  if (describedBulks.get(description) !== bulk) {
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB description belongs to another bulk statement or adapter.");
  }
  if (description.parameterizedSql === undefined) {
    throw new Error("BRAID_BIND_TRANSPORT: MariaDB bulk binding description did not provide parameterized SQL.");
  }
  if (description.itemCount !== bulk.parameterSets.length) {
    throw new TypeError(
      "BRAID_BULK_SHAPE: MariaDB bulk binding item count does not match the rendered parameter matrix.",
    );
  }
  const matrix = bulkMatrices.get(description);
  if (matrix === undefined)
    throw new TypeError("BRAID_BINDING_IDENTITY: MariaDB bulk description has no encoded parameter matrix.");
  const values: readonly (readonly unknown[])[] = Array.from(
    { length: description.itemCount },
    (_, index) => matrix[index] ?? description.valuesAt(index),
  );
  return { text: description.parameterizedSql, values, itemCount: description.itemCount };
}

function streamClose(stream: MariaDbStreamLike): Promise<void> {
  try {
    return Promise.resolve(stream.close?.()).then(() => undefined);
  } catch (error) {
    return Promise.reject(error);
  }
}

function connectionControl(connection: MariaDbConnectionLike): (sql: string) => Promise<void> {
  const run = connection.query ?? connection.execute;
  return async (sql: string): Promise<void> => {
    await run.call(connection, sql);
  };
}

function invalidTransactionOptions(message: string): never {
  const error = new TypeError(`BRAID_TX_OPTIONS_INVALID: ${message}`);
  Object.defineProperty(error, "code", { value: "BRAID_TX_OPTIONS_INVALID", enumerable: true });
  throw error;
}

/** Wrap one connected MariaDB Connector/Node.js connection; caller owns connection shutdown. */
export function createMariaDbExecutor(
  connection: MariaDbConnectionLike,
  options: MariaDbExecutorOptions = {},
): QueryExecutor {
  assertMariaDbConnection(connection);
  const representationProfile = mariaDbProfile(options.profile);
  const policy = options.typePolicy ?? representationProfile.typePolicy;
  const control = connectionControl(connection);
  const begin = async (transactionOptions?: TransactionOptions): Promise<void> => {
    if (
      transactionOptions !== undefined &&
      (transactionOptions === null || typeof transactionOptions !== "object" || Array.isArray(transactionOptions))
    ) {
      invalidTransactionOptions("MariaDB transaction options must be an object.");
    }
    if (transactionOptions !== undefined) {
      const unexpected = Object.keys(transactionOptions).find((key) => key !== "isolation" && key !== "readOnly");
      if (unexpected !== undefined) invalidTransactionOptions(`Unknown MariaDB transaction option: ${unexpected}.`);
    }
    const clauses: string[] = [];
    if (
      transactionOptions?.isolation !== undefined &&
      transactionOptions.isolation !== "read-uncommitted" &&
      transactionOptions.isolation !== "read-committed" &&
      transactionOptions.isolation !== "repeatable-read" &&
      transactionOptions.isolation !== "serializable"
    ) {
      invalidTransactionOptions(
        `MariaDB does not recognize transaction isolation ${String(transactionOptions.isolation)}.`,
      );
    }
    if (transactionOptions?.readOnly !== undefined && typeof transactionOptions.readOnly !== "boolean") {
      invalidTransactionOptions("MariaDB readOnly must be a boolean.");
    }
    if (transactionOptions?.isolation !== undefined) {
      const levels: Readonly<Record<NonNullable<TransactionOptions["isolation"]>, string>> = {
        "read-uncommitted": "READ UNCOMMITTED",
        "read-committed": "READ COMMITTED",
        "repeatable-read": "REPEATABLE READ",
        serializable: "SERIALIZABLE",
      };
      clauses.push(`ISOLATION LEVEL ${levels[transactionOptions.isolation]}`);
    }
    if (transactionOptions?.readOnly === true) clauses.push("READ ONLY");
    else if (transactionOptions?.readOnly === false) clauses.push("READ WRITE");
    if (clauses.length > 0) await control(`SET TRANSACTION ${clauses.join(", ")}`);
    await connection.beginTransaction();
  };
  return {
    ownershipKey: connection,
    statementBinding: mariaDbStatementBinding,
    environment: mariaDbEnvironment(options.profile, policy),
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const result = await executeWithCancellation(
        connection,
        () =>
          connection.execute(
            { sql: prepared.text, rowsAsArray: true, metaAsArray: true, insertIdAsNumber: false },
            prepared.values,
          ),
        executionOptions,
      );
      return resultRows(normalizeMetadataResult(result), policy) as QueryExecutionResult<Row>;
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      assertParameterHintsUnsupported(rendered);
      assertRoutineOutputsUnsupported(rendered);
      assertExecutionOptions(connection, executionOptions);
      const signal = executionOptions?.signal;
      if (typeof connection.queryStream !== "function") {
        throw new UnsupportedFeatureError(
          "statement.stream",
          "BRAID_STREAM_UNSUPPORTED",
          "MariaDB Connector/Node.js connection does not expose queryStream().",
        );
      }
      const prepared = materialize(rendered, binding);
      const stream = connection.queryStream(
        { sql: prepared.text, rowsAsArray: true, metaAsArray: true },
        prepared.values,
      );
      const cleanup = createCleanupScope();
      const noPrimary = Symbol("mariadb.stream.no-primary");
      let primary: unknown = noPrimary;
      let fields: readonly MariaDbFieldLike[] = [];
      let names: readonly (string | undefined)[] = [];
      let fieldsChanged = false;
      let projectRow: ((value: unknown) => Record<string, unknown>) | undefined;
      let fieldsSeen = 0;
      let pendingError: unknown;
      const onFields = (value: unknown): void => {
        fieldsSeen += 1;
        if (fieldsSeen === 1) {
          fields = Array.isArray(value) ? (value as readonly MariaDbFieldLike[]) : [];
          fieldsChanged = true;
          projectRow = undefined;
        } else {
          pendingError ??= new UnsupportedFeatureError(
            "routine.result-sets",
            "BRAID_RESULT_SETS_UNSUPPORTED",
            "MariaDB stream returned multiple result sets; use database.call().",
          );
        }
      };
      let exhausted = false;
      let abortRequested = false;
      let destroyed = false;
      let destroyFailure: unknown;
      const abort = (): void => {
        if (abortRequested) return;
        abortRequested = true;
        if (destroyed) return;
        destroyed = true;
        try {
          connection.destroy!();
        } catch (error) {
          destroyFailure ??= error;
        }
      };
      try {
        cleanup.add(async () => {
          if (abortRequested) {
            if (!destroyed) {
              destroyed = true;
              try {
                connection.destroy!();
              } catch (error) {
                destroyFailure ??= error;
              }
            }
            if (destroyFailure !== undefined) {
              throw cleanupError("MariaDB stream cancellation cleanup failed.", destroyFailure);
            }
            throw cleanupError(
              "MariaDB cancellation discarded the physical connection.",
              signal?.reason ?? new Error("Execution aborted."),
            );
          }
          if (!exhausted) {
            if (typeof stream.close !== "function") {
              if (!destroyed && typeof connection.destroy === "function") {
                destroyed = true;
                try {
                  connection.destroy();
                } catch (error) {
                  destroyFailure ??= error;
                }
              }
              throw cleanupError(
                "MariaDB stream cleanup requires queryStream().close(); the physical connection was discarded.",
                destroyFailure,
              );
            }
            await streamClose(stream);
          }
          if (destroyFailure !== undefined) {
            throw cleanupError("MariaDB stream cancellation cleanup failed.", destroyFailure);
          }
        });
        if (typeof stream.close !== "function") {
          throw new UnsupportedFeatureError(
            "statement.stream",
            "BRAID_STREAM_UNSUPPORTED",
            "MariaDB Connector/Node.js queryStream does not expose close().",
          );
        }
        (stream.on ?? stream.once)?.call(stream, "fields", onFields);
        const iterator = stream[Symbol.asyncIterator]();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        while (true) {
          signal?.throwIfAborted();
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume one cursor row at a time to preserve backpressure and cancellation.
          const next = await iterator.next();
          exhausted = next.done === true;
          if (pendingError !== undefined) throw pendingError;
          if (fieldsChanged) {
            names = assertUniqueFields(fields);
            if (fields.length === 0) throw new DatabaseResultKindError("rows", "command");
            fieldsChanged = false;
          }
          if (next.done) {
            if (fieldsSeen === 0) throw new DatabaseResultKindError("rows", "command");
            break;
          }
          signal?.throwIfAborted();
          projectRow ??= prepareMariaDbRowProjector(fields, names, policy);
          yield projectRow!(next.value) as Row;
        }
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        try {
          const result = primary === noPrimary ? cleanup.run() : cleanup.run(primary);
          if (result !== undefined) await result;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    async call(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<DriverRoutineResult> {
      assertRoutineOutputsUnsupported(rendered);
      assertParameterHintsUnsupported(rendered);
      const prepared = materialize(rendered, binding);
      const value = await executeWithCancellation(
        connection,
        () =>
          connection.execute(
            { sql: prepared.text, rowsAsArray: true, metaAsArray: true, insertIdAsNumber: false },
            prepared.values,
          ),
        executionOptions,
      );
      const normalized = normalizeMetadataResult(value);
      if (!Array.isArray(normalized)) return { output: {}, resultSets: [] };
      const sets = isNestedResultPayload(normalized)
        ? normalized.filter((entry): entry is MariaDbRowSet => Array.isArray(entry))
        : [normalized as MariaDbRowSet];
      const resultSets = sets.map((rows, index) => {
        const fields = fieldsFor(rows);
        const names = assertUniqueFields(fields);
        const projectRow =
          rows.length === 0 ? undefined : prepareMariaDbRowProjector(fields, names, policy, rows.length);
        return {
          rows: projectRow === undefined ? [] : rows.map(projectRow),
          source: { kind: "emitted" as const, index },
        };
      });
      return { output: {}, resultSets };
    },
    async bulk(bulk: RenderedBulk, binding: BulkBindingDescription, executionOptions?: ExecutionOptions) {
      const prepared = materializeBulk(bulk, binding);
      if (typeof connection.batch !== "function") {
        throw new UnsupportedFeatureError(
          "statement.bulk",
          "BRAID_BULK_UNSUPPORTED",
          "MariaDB Connector/Node.js connection does not expose batch().",
        );
      }
      const result = await executeWithCancellation(
        connection,
        () => connection.batch!({ sql: prepared.text, insertIdAsNumber: false }, prepared.values),
        executionOptions,
      );
      return {
        inputCount: prepared.itemCount,
        affectedRows: affectedRows(result),
        executionMode: "native-bulk" as const,
      };
    },
    begin,
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    savepoint: (name) => control(`SAVEPOINT ${assertSavepointName(name)}`),
    rollbackTo: (name) => control(`ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`),
    releaseSavepoint: (name) => control(`RELEASE SAVEPOINT ${assertSavepointName(name)}`),
  };
}

/** Wrap one connected MariaDB connection as an application database. */
export function createMariaDbDatabase(connection: MariaDbConnectionLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, profile, ...databaseOptions } = options;
  return createDatabase(createMariaDbExecutor(connection, { typePolicy, profile }), databaseOptions);
}

/** Create a lease provider from a MariaDB pool; lease release returns the native connection. */
export function createMariaDbPoolProvider(
  pool: MariaDbPoolLike,
  options: MariaDbExecutorOptions = {},
): ConnectionProvider {
  if (!pool || typeof pool !== "object" || typeof pool.getConnection !== "function") {
    throw new TypeError("SQLBraid MariaDB pool adapter requires a MariaDB Connector/Node.js Pool.");
  }
  return {
    statementBinding: mariaDbStatementBinding,
    environment: mariaDbEnvironment(options.profile, options.typePolicy ?? mariaDbProfile(options.profile).typePolicy),
    async acquire(): Promise<ConnectionLease> {
      const connection = await pool.getConnection();
      try {
        const executor = createMariaDbExecutor(connection, options);
        let released = false;
        return {
          ...executor,
          async release(releaseOptions = {}): Promise<void> {
            if (released) return;
            released = true;
            if (releaseOptions.discard === true) {
              try {
                if (typeof connection.destroy === "function") {
                  connection.destroy();
                  return;
                }
                if (typeof connection.end === "function") {
                  await connection.end();
                  return;
                }
                throw cleanupError("MariaDB pool connection cannot be discarded safely.");
              } catch (error) {
                if ((error as { readonly code?: unknown }).code === "BRAID_RESOURCE_CLEANUP") throw error;
                throw cleanupError("MariaDB pool discard failed.", error);
              }
            }
            await connection.release();
          },
        };
      } catch (error) {
        try {
          await connection.release();
        } catch (cleanup) {
          throw cleanupAggregate([error, cleanup], "MariaDB pool initialization cleanup failed.", error);
        }
        throw error;
      }
    },
  };
}

/** Wrap a MariaDB pool as a pooled application database with one lease per root operation. */
export function createMariaDbPoolDatabase(pool: MariaDbPoolLike, options: MariaDbDatabaseOptions = {}) {
  const { typePolicy, profile, ...databaseOptions } = options;
  return createPooledDatabase(createMariaDbPoolProvider(pool, { typePolicy, profile }), databaseOptions);
}
