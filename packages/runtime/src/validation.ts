import { ResultExactnessError, safeDatabaseCount } from "@sqlbraid/core";
import type {
  BulkExecutionResult,
  Query,
  ExecutableQuery,
  RowQuery,
  QueryExecutionResult,
  QueryResultKind,
  StandardSchemaV1,
} from "@sqlbraid/core";
import { DatabaseResultKindError, DatabaseResultValidationError } from "./errors.js";

export function malformedExecutionResult(): never {
  throw new TypeError("Executor returned a malformed query execution result.");
}

export function addSafeCount(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new ResultExactnessError("Database row count exceeds the safe JavaScript integer range.");
  }
  return left + right;
}

export function assertBulkExecutionResult(value: unknown, expectedCount: number): BulkExecutionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Executor returned a malformed bulk execution result.");
  }
  const result = value as Partial<BulkExecutionResult>;
  const inputCount = result.inputCount;
  const executionMode = result.executionMode;
  if (
    typeof inputCount !== "number" ||
    !Number.isSafeInteger(inputCount) ||
    inputCount !== expectedCount ||
    (executionMode !== "native-bulk" &&
      executionMode !== "pipeline" &&
      executionMode !== "prepared-loop" &&
      executionMode !== "remote-batch")
  ) {
    throw new TypeError("Executor returned a malformed bulk execution result.");
  }
  const affectedRows = result.affectedRows === undefined ? undefined : safeDatabaseCount(result.affectedRows);
  return {
    inputCount,
    ...(affectedRows === undefined ? {} : { affectedRows }),
    executionMode,
  };
}

export function assertExecutableQuery(query: Query<unknown, QueryResultKind>): asserts query is ExecutableQuery {
  if (query.resultKind === "call") throw new TypeError("Call queries must be executed with database.call().");
}

export function assertRowsQuery(query: Query<unknown, QueryResultKind>): asserts query is RowQuery<unknown> {
  if (query.resultKind === "call") throw new TypeError("Call queries must be executed with database.call().");
  if (query.resultKind === "command") throw new DatabaseResultKindError("command", "rows");
}

export function standardSchemaFor<Input, Output>(
  schema: StandardSchemaV1<Input, Output> | undefined,
): StandardSchemaV1.Props<Input, Output> | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== "object") throw new TypeError("Standard Schema validator is malformed.");
  const candidate = (schema as { readonly "~standard"?: unknown })["~standard"];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Standard Schema validator is malformed.");
  }
  const standard = candidate as { readonly version?: unknown; readonly validate?: unknown };
  if (standard.version !== 1 || typeof standard.validate !== "function") {
    throw new TypeError("Standard Schema validator is malformed.");
  }
  return standard as StandardSchemaV1.Props<Input, Output>;
}

export function isStandardSchemaSuccess<T>(result: unknown): result is StandardSchemaV1.SuccessResult<T> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as { readonly value?: unknown; readonly issues?: unknown };
  return "value" in candidate && candidate.issues === undefined;
}

export function isStandardSchemaFailure(result: unknown): result is StandardSchemaV1.FailureResult {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as { readonly value?: unknown; readonly issues?: unknown };
  return Array.isArray(candidate.issues) && (!("value" in candidate) || candidate.value === undefined);
}

export function assertStandardSchemaResult(result: unknown): asserts result is StandardSchemaV1.Result<unknown> {
  if (!isStandardSchemaSuccess(result) && !isStandardSchemaFailure(result)) {
    throw new TypeError("Standard Schema validator returned a malformed result.");
  }
}

export async function validateRow<Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  row: unknown,
  rowIndex: number,
  stage: "query" | "execution",
): Promise<Output> {
  const result = await standard.validate(row);
  assertStandardSchemaResult(result);
  if (isStandardSchemaFailure(result)) throw new DatabaseResultValidationError(result.issues, rowIndex, stage);
  return result.value;
}

export function resourceCleanupFailure(error: unknown): boolean {
  if (error instanceof Error && "code" in error && error.code === "BRAID_RESOURCE_CLEANUP") return true;
  return error instanceof AggregateError && error.errors.some(resourceCleanupFailure);
}

export function assertExecutionResult<Row>(
  query: Query<unknown, QueryResultKind>,
  result: QueryExecutionResult<Row>,
): QueryExecutionResult<Row> {
  if (
    result === null ||
    typeof result !== "object" ||
    (result.kind !== "rows" && result.kind !== "command") ||
    !Array.isArray(result.rows)
  ) {
    malformedExecutionResult();
  }
  if (result.kind === "rows") {
    if ("command" in result && result.command !== undefined) malformedExecutionResult();
  } else if (
    result.rows.length !== 0 ||
    !result.command ||
    typeof result.command !== "object" ||
    Array.isArray(result.command)
  ) {
    malformedExecutionResult();
  }
  if (query.resultKind !== "unknown" && query.resultKind !== result.kind) {
    throw new DatabaseResultKindError(query.resultKind, result.kind);
  }
  const rowCount = result.rowCount === undefined ? undefined : safeDatabaseCount(result.rowCount);
  if (result.kind === "rows") {
    return rowCount === result.rowCount ? result : { ...result, rowCount };
  }
  if (result.command.insertId !== undefined && typeof result.command.insertId !== "string") {
    throw new ResultExactnessError("Database insertId must be represented as an exact string.");
  }
  const affectedRows =
    result.command.affectedRows === undefined ? undefined : safeDatabaseCount(result.command.affectedRows);
  if (rowCount === result.rowCount && affectedRows === result.command.affectedRows) return result;
  return {
    ...result,
    ...(rowCount === undefined ? {} : { rowCount }),
    command: {
      ...result.command,
      ...(affectedRows === undefined ? {} : { affectedRows }),
    },
  };
}
