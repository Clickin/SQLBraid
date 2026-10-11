import type {
  BulkBindingDescription,
  BulkExecutionResult,
  DriverRoutineResult,
  ExecutionOptions,
  QueryExecutionResult,
  QueryExecutor,
  RenderedBulk,
  RenderedStatement,
  StatementBindingDescription,
} from "@sqlbraid/core";
import { safeDatabaseCount } from "@sqlbraid/core";
import { createDatabase } from "@sqlbraid/runtime";
import {
  assertParameterHintsUnsupported,
  assertPgBulkBinding,
  pgStatementBinding,
  resolvePgBinding,
} from "../common/binding.js";
import { unsupported } from "../common/errors.js";
import { losslessEnvironmentFor, losslessPolicy, losslessProfile, rejectActiveSignal } from "../common/lossless.js";
import { assertUniqueFields, projectPgRows } from "../common/results.js";
import { queryTypeOverrides } from "../common/type-overrides.js";
import type {
  NeonHttpCalls,
  NeonHttpDatabaseOptions,
  NeonHttpExecutorOptions,
  NeonHttpLike,
  NeonHttpQueryOptionsLike,
  NeonHttpResultLike,
} from "./types.js";

export type {
  NeonHttpDatabaseOptions,
  NeonHttpExecutorOptions,
  NeonHttpLike,
  NeonHttpQueryOptionsLike,
  NeonHttpResultLike,
} from "./types.js";

const unsupportedCapabilities = Object.freeze({
  "session.pinned": { status: "unsupported" as const, conditionCode: "neon-http.stateless-requests" },
  transaction: { status: "unsupported" as const, conditionCode: "neon-http.non-interactive-transaction" },
  "transaction.savepoint": { status: "unsupported" as const },
  "transaction.read-only": { status: "unsupported" as const },
  "transaction.isolation.read-uncommitted": { status: "unsupported" as const },
  "transaction.isolation.read-committed": { status: "unsupported" as const },
  "transaction.isolation.repeatable-read": { status: "unsupported" as const },
  "transaction.isolation.serializable": { status: "unsupported" as const },
  "statement.cancel": { status: "unsupported" as const },
  "statement.stream": { status: "unsupported" as const },
  "routine.call": { status: "unsupported" as const },
  "routine.out": { status: "unsupported" as const },
  "routine.result-sets": { status: "unsupported" as const },
  "routine.out-cursor": { status: "unsupported" as const },
});

const driver = Object.freeze({ id: "neon-http", capabilities: unsupportedCapabilities });

function boolean(value: string): boolean {
  return value === "t";
}

function bytea(value: string): Uint8Array {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

// Types that the lossless profile does not change need a parser here, because Neon uses its own defaults otherwise.
const types = queryTypeOverrides((oid) => (oid === 16 ? boolean : oid === 17 ? bytea : undefined), losslessProfile);
const queryOptions: NeonHttpQueryOptionsLike = Object.freeze({ arrayMode: true, fullResults: true, types });

function assertResult(value: unknown): NeonHttpResultLike {
  const result = value as Partial<NeonHttpResultLike> | null | undefined;
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.fields)) {
    throw new TypeError("BRAID_RESULT_SHAPE: the neon() function did not return full array-mode results.");
  }
  return result as NeonHttpResultLike;
}

function rejectSignal(options: ExecutionOptions | undefined): void {
  rejectActiveSignal("The Neon HTTP adapter has no statement cancellation. It rejects an active AbortSignal.", options);
}

/** Wrap a `neon()` query function. Each statement is one HTTP request, so no connection is pinned. */
export function createNeonHttpExecutor(sql: NeonHttpLike, options: NeonHttpExecutorOptions = {}): QueryExecutor {
  if (!sql || typeof sql.query !== "function" || typeof sql.transaction !== "function") {
    throw new TypeError("SQLBraid Neon HTTP adapter requires a neon() query function.");
  }
  const calls = sql as unknown as NeonHttpCalls;
  const policy = options.typePolicy ?? losslessPolicy;
  return {
    ownershipKey: sql,
    statementBinding: pgStatementBinding,
    environment: losslessEnvironmentFor(driver, policy),
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      rejectSignal(executionOptions);
      assertParameterHintsUnsupported(rendered);
      const { text, values } = resolvePgBinding(rendered, binding);
      const result = assertResult(await calls.query(text, values, queryOptions));
      assertUniqueFields(result.fields);
      const rows = projectPgRows(result.rows, result.fields, policy);
      const rowCount = result.rowCount === null ? undefined : safeDatabaseCount(result.rowCount);
      const rowBearing = result.fields.length > 0 || result.rows.length > 0 || result.command === "SELECT";
      return rowBearing
        ? { rows: rows as readonly Row[], rowCount, kind: "rows" }
        : { rows: [], rowCount, kind: "command", command: { affectedRows: rowCount } };
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      rejectSignal(executionOptions);
      assertPgBulkBinding(bulk, binding);
      if (binding.itemCount === 0) return { inputCount: 0, affectedRows: 0, executionMode: "remote-batch" };
      // One HTTP request runs every statement in one server-side transaction.
      const queries = Array.from({ length: binding.itemCount }, (_, index) =>
        calls.query(binding.parameterizedSql!, binding.valuesAt(index), queryOptions),
      );
      const results = (await calls.transaction(queries)).map(assertResult);
      let affectedRows = 0;
      let affectedKnown = true;
      for (const result of results) {
        if (result.fields.length > 0 || result.rows.length > 0) {
          throw new Error("BRAID_BULK_RESULT_KIND: PostgreSQL bulk command returned rows.");
        }
        if (typeof result.rowCount === "number") affectedRows += safeDatabaseCount(result.rowCount);
        else affectedKnown = false;
      }
      return {
        inputCount: binding.itemCount,
        ...(affectedKnown ? { affectedRows: safeDatabaseCount(affectedRows) } : {}),
        executionMode: "remote-batch",
      };
    },
    stream<Row>(
      _rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncIterable<Row> {
      rejectSignal(executionOptions);
      throw unsupported(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "Neon HTTP returns one complete response. The adapter does not buffer rows to simulate a stream.",
      );
    },
    call(
      _rendered: RenderedStatement,
      _binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<DriverRoutineResult> {
      rejectSignal(executionOptions);
      throw unsupported(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "The Neon HTTP adapter does not implement routine calls.",
      );
    },
  };
}

/** Wrap a `neon()` query function as an application database. `db.tx()` and `db.session()` reject. */
export function createNeonHttpDatabase(sql: NeonHttpLike, options: NeonHttpDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createDatabase(createNeonHttpExecutor(sql, { typePolicy }), databaseOptions);
}
