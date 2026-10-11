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
import { AdapterError, safeDatabaseCount } from "@sqlbraid/core";
import { assertSavepointName } from "@sqlbraid/core/driver";
import { createDatabase } from "@sqlbraid/runtime";
import {
  assertParameterHintsUnsupported,
  assertPgBulkBinding,
  pgStatementBinding,
  resolvePgBinding,
} from "../common/binding.js";
import { unsupported } from "../common/errors.js";
import { losslessEnvironmentFor, losslessPolicy, rejectActiveSignal } from "../common/lossless.js";
import { arrayOids, exactNumericOids, jsonOids, temporalOids } from "../common/oids.js";
import { assertUniqueFields, projectPgRows } from "../common/results.js";
import { postgresBeginSql } from "../common/transaction.js";
import type {
  PgliteDatabaseOptions,
  PgliteExecutorOptions,
  PgliteLike,
  PgliteQueryOptionsLike,
  PgliteResultLike,
} from "./types.js";

export type {
  PgliteDatabaseOptions,
  PgliteExecutorOptions,
  PgliteLike,
  PgliteQueryOptionsLike,
  PgliteResultLike,
} from "./types.js";

const unsupportedCapabilities = Object.freeze({
  "statement.cancel": { status: "unsupported" as const },
  "statement.stream": { status: "unsupported" as const },
  "routine.call": { status: "unsupported" as const },
  "routine.out": { status: "unsupported" as const },
  "routine.result-sets": { status: "unsupported" as const },
  "routine.out-cursor": { status: "unsupported" as const },
});

const driver = Object.freeze({ id: "pglite", capabilities: unsupportedCapabilities });

function identity(value: string): string {
  return value;
}

function binary64(value: string): number {
  return Number(value);
}

function binary32(value: string): number {
  return Math.fround(Number(value));
}

// PGlite parses int8, json, dates and arrays by default. These parsers keep the lossless text profile.
const losslessParsers: Readonly<Record<number, (value: string) => unknown>> = (() => {
  const parsers: Record<number, (value: string) => unknown> = {};
  for (const oid of [...exactNumericOids, ...jsonOids, ...temporalOids, ...arrayOids]) parsers[oid] = identity;
  parsers[700] = binary32;
  parsers[701] = binary64;
  return Object.freeze(parsers);
})();

const queryOptions: PgliteQueryOptionsLike = Object.freeze({ rowMode: "array", parsers: losslessParsers });

function rejectSignal(options: ExecutionOptions | undefined): void {
  rejectActiveSignal("PGlite has no statement cancellation. The adapter rejects an active AbortSignal.", options);
}

/**
 * Wrap one `PGlite` instance. PGlite is one connection in one process, so SQLBraid must own the instance:
 * a direct call on it during `db.tx()` would join the open transaction. SQLBraid does not close the instance.
 */
export function createPgliteExecutor(pg: PgliteLike, options: PgliteExecutorOptions = {}): QueryExecutor {
  if (!pg || typeof pg.query !== "function") throw new TypeError("SQLBraid PGlite adapter requires a PGlite instance.");
  const policy = options.typePolicy ?? losslessPolicy;
  const runControl = async (text: string): Promise<void> => {
    const result = await pg.query(text, [], queryOptions);
    if (text === "COMMIT" && result.command !== undefined && result.command !== "COMMIT") {
      throw new AdapterError(
        "BRAID_TX_NOT_COMMITTED",
        `PostgreSQL COMMIT completed with ${result.command}, not COMMIT.`,
      );
    }
  };
  return {
    ownershipKey: pg,
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
      const result: PgliteResultLike = await pg.query(text, values, queryOptions);
      const fields = result.fields ?? [];
      assertUniqueFields(fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })));
      const rows = projectPgRows(result.rows, fields, policy);
      const rowCount = result.affectedRows === undefined ? undefined : safeDatabaseCount(result.affectedRows);
      const rowBearing = fields.length > 0 || result.rows.length > 0;
      return rowBearing
        ? { rows: rows as readonly Row[], rowCount: rows.length, kind: "rows" }
        : { rows: [], rowCount, kind: "command", command: { affectedRows: rowCount } };
    },
    async bulk(
      bulk: RenderedBulk,
      binding: BulkBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<BulkExecutionResult> {
      rejectSignal(executionOptions);
      assertPgBulkBinding(bulk, binding);
      let affectedRows = 0;
      let affectedKnown = true;
      for (let index = 0; index < binding.itemCount; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- PGlite runs one statement at a time
        const result = await pg.query(binding.parameterizedSql!, binding.valuesAt(index), queryOptions);
        if ((result.fields?.length ?? 0) > 0 || result.rows.length > 0) {
          throw new Error("BRAID_BULK_RESULT_KIND: PostgreSQL bulk command returned rows.");
        }
        if (typeof result.affectedRows === "number") affectedRows += safeDatabaseCount(result.affectedRows);
        else affectedKnown = false;
      }
      return {
        inputCount: binding.itemCount,
        ...(affectedKnown ? { affectedRows: safeDatabaseCount(affectedRows) } : {}),
        executionMode: "prepared-loop",
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
        "PGlite has no incremental result protocol. The adapter does not buffer rows to simulate a stream.",
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
        "The PGlite adapter does not implement routine calls.",
      );
    },
    begin: async (transactionOptions) => {
      await runControl(postgresBeginSql(transactionOptions));
    },
    commit: () => runControl("COMMIT"),
    rollback: () => runControl("ROLLBACK"),
    savepoint: (name) => runControl(`SAVEPOINT ${assertSavepointName(name)}`),
    rollbackTo: (name) => runControl(`ROLLBACK TO SAVEPOINT ${assertSavepointName(name)}`),
    releaseSavepoint: (name) => runControl(`RELEASE SAVEPOINT ${assertSavepointName(name)}`),
  };
}

/** Wrap one `PGlite` instance as an application database. */
export function createPgliteDatabase(pg: PgliteLike, options: PgliteDatabaseOptions = {}) {
  const { typePolicy, ...databaseOptions } = options;
  return createDatabase(createPgliteExecutor(pg, { typePolicy }), databaseOptions);
}
