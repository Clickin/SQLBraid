import { RoutineMappingError } from "@sqlbraid/core";
import type {
  DriverRoutineResult,
  RoutineCallResult,
  RoutineContract,
  RoutineMappingLocation,
  StandardSchemaV1,
  RenderedStatement,
  CallQuery,
  PreparableQuery,
  ExecutableQuery,
  RowQuery,
} from "@sqlbraid/core";
import { DatabaseResultValidationError } from "./errors.js";
import { assertExecutableQuery, assertRowsQuery } from "./validation.js";
import type { PreparedOperation } from "./state.js";
import { addSafeCount, assertStandardSchemaResult, isStandardSchemaFailure, standardSchemaFor } from "./validation.js";

export function assertDriverRoutineResult(value: unknown): asserts value is DriverRoutineResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformedRoutineResult();
  const result = value as Partial<DriverRoutineResult>;
  if (result.output === null || typeof result.output !== "object" || Array.isArray(result.output))
    malformedRoutineResult();
  if (!Array.isArray(result.resultSets)) malformedRoutineResult();
  for (const resultSet of result.resultSets) {
    if (
      resultSet === null ||
      typeof resultSet !== "object" ||
      Array.isArray(resultSet) ||
      !Array.isArray(resultSet.rows)
    ) {
      malformedRoutineResult();
    }
    const source = resultSet.source;
    if (
      source === null ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      (source.kind !== "out-cursor" && source.kind !== "implicit" && source.kind !== "emitted")
    ) {
      malformedRoutineResult();
    }
    if (source.kind !== "out-cursor" && (!Number.isInteger(source.index) || source.index < 0)) {
      malformedRoutineResult();
    }
  }
}

function malformedRoutineResult(): never {
  throw new TypeError("Executor returned a malformed routine execution result.");
}

export function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  Object.defineProperty(error, "code", { configurable: false, enumerable: true, value: code });
  return error;
}

export function callRequiresTransaction(rendered: RenderedStatement): boolean {
  return rendered.parameters.some((parameter) => {
    const direction = parameter.direction;
    return (direction === "out" || direction === "inout") && parameter.hint?.databaseType.toLowerCase() === "refcursor";
  });
}

export function executablePreparedOperation(
  operation: PreparedOperation<PreparableQuery>,
): PreparedOperation<ExecutableQuery> {
  const query = operation.query;
  assertExecutableQuery(query);
  return { ...operation, query };
}

export function rowPreparedOperation(
  operation: PreparedOperation<PreparableQuery>,
): PreparedOperation<RowQuery<unknown>> {
  const query = operation.query;
  assertRowsQuery(query);
  return { ...operation, query };
}

export function callPreparedOperation(operation: PreparedOperation<PreparableQuery>): PreparedOperation<CallQuery> {
  const query = operation.query;
  if (query.resultKind !== "call") throw new TypeError("Only call queries may be executed with prepared.call().");
  return { ...operation, query };
}

export async function mapRoutineValue(
  schema: StandardSchemaV1<unknown, unknown>,
  value: unknown,
  location: RoutineMappingLocation,
): Promise<unknown> {
  try {
    const standard = standardSchemaFor(schema) as StandardSchemaV1.Props<unknown, unknown>;
    const result = await standard.validate(value);
    assertStandardSchemaResult(result);
    if (isStandardSchemaFailure(result)) {
      const rowIndex = location.kind === "result-set" ? location.rowIndex : undefined;
      throw new RoutineMappingError(
        `Routine ${
          location.kind === "result-set"
            ? `result set ${location.resultSetIndex}, row ${location.rowIndex}`
            : location.kind === "return-value"
              ? "return value"
              : "output"
        } failed validation.`,
        location,
        { cause: new DatabaseResultValidationError(result.issues, rowIndex, "query", location) },
      );
    }
    return result.value;
  } catch (error) {
    if (error instanceof RoutineMappingError) throw error;
    throw new RoutineMappingError(
      `Routine ${
        location.kind === "result-set"
          ? `result set ${location.resultSetIndex}, row ${location.rowIndex}`
          : location.kind === "return-value"
            ? "return value"
            : "output"
      } mapping failed.`,
      location,
      { cause: error },
    );
  }
}

export function routineMappingRequested(contract: RoutineContract | undefined): boolean {
  return (
    contract !== undefined &&
    (contract.output !== undefined || contract.resultSets !== undefined || contract.returnValue !== undefined)
  );
}

export async function mapRoutineResult(
  raw: DriverRoutineResult,
  contract: RoutineContract | undefined,
): Promise<{ readonly value: RoutineCallResult; readonly rowCount: number; readonly mapped: boolean }> {
  assertDriverRoutineResult(raw);
  let rowCount = 0;
  for (const resultSet of raw.resultSets) rowCount = addSafeCount(rowCount, resultSet.rows.length);
  if (!routineMappingRequested(contract)) {
    const value = {
      output: raw.output,
      resultSets: raw.resultSets.map((resultSet) => ({ rows: resultSet.rows })),
      ...(Object.hasOwn(raw, "returnValue") ? { returnValue: raw.returnValue } : {}),
    };
    return { value, rowCount, mapped: false };
  }

  if (contract?.resultSets !== undefined && raw.resultSets.length !== contract.resultSets.length) {
    throw codedError(
      "BRAID_CALL_RESULT_SETS",
      `Expected ${contract.resultSets.length} result sets, received ${raw.resultSets.length}.`,
    );
  }
  if (contract?.returnValue !== undefined && !Object.hasOwn(raw, "returnValue")) {
    throw codedError("BRAID_CALL_RETURN_UNSUPPORTED", "The routine did not expose a return/status channel.");
  }
  const output =
    contract?.output === undefined
      ? raw.output
      : await mapRoutineValue(contract.output, raw.output, { kind: "output" });
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new RoutineMappingError("Routine output schema must produce an object.", { kind: "output" });
  }
  const resultSets = [];
  for (let resultSetIndex = 0; resultSetIndex < raw.resultSets.length; resultSetIndex += 1) {
    const source = raw.resultSets[resultSetIndex];
    const schema = contract?.resultSets?.[resultSetIndex];
    if (schema === undefined) {
      resultSets.push({ rows: source.rows });
      continue;
    }
    const rows: unknown[] = [];
    for (let rowIndex = 0; rowIndex < source.rows.length; rowIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Preserve result-set row order during schema mapping.
      rows.push(await mapRoutineValue(schema, source.rows[rowIndex], { kind: "result-set", resultSetIndex, rowIndex }));
    }
    resultSets.push({ rows });
  }
  const value = {
    output: output as Readonly<Record<string, unknown>>,
    resultSets,
    ...(Object.hasOwn(raw, "returnValue")
      ? {
          returnValue:
            contract?.returnValue === undefined
              ? raw.returnValue
              : await mapRoutineValue(contract.returnValue, raw.returnValue, { kind: "return-value" }),
        }
      : {}),
  };
  return { value, rowCount, mapped: true };
}
