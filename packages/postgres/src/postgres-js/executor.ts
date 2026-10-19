import type {
  BulkBindingDescription,
  BulkExecutionResult,
  ConnectionLease,
  ConnectionProvider,
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
import { createPooledDatabase, DatabaseResultKindError } from "@sqlbraid/runtime";
import { assertPgBulkBinding, pgTypedStatementBinding, resolvePgBinding } from "../common/binding.js";
import { postgresParameterTypeOids } from "../common/parameter-types.js";
import { cleanupAggregate, unsupported } from "../common/errors.js";
import { assertUniqueFields, preparePgRowProjector, projectPgRows } from "../common/results.js";
import { postgresBeginSql, resolveStreamBatchSize } from "../common/transaction.js";
import { losslessEnvironmentFor, losslessPolicy, rejectActiveSignal } from "../common/lossless.js";
import type { PgFieldLike } from "../pg/types.js";
import { assertPostgresJsLossless } from "./options.js";
import type {
  PostgresJsDatabaseOptions,
  PostgresJsExecutorOptions,
  PostgresJsLike,
  PostgresJsReservedLike,
  PostgresJsResultLike,
} from "./types.js";

export type {
  PostgresJsDatabaseOptions,
  PostgresJsExecutorOptions,
  PostgresJsLike,
  PostgresJsReservedLike,
  PostgresJsResultLike,
} from "./types.js";

const unsupportedCapabilities = Object.freeze({
  "statement.cancel": { status: "unsupported" as const },
  "routine.call": { status: "unsupported" as const },
  "routine.out": { status: "unsupported" as const },
  "routine.result-sets": { status: "unsupported" as const },
  "routine.out-cursor": { status: "unsupported" as const },
});

const driver = Object.freeze({ id: "postgres-js", capabilities: unsupportedCapabilities });

function fieldsOf(result: PostgresJsResultLike): readonly PgFieldLike[] {
  return (result.columns ?? []).map((column) => ({ name: column.name, dataTypeID: column.type }));
}

function rejectSignal(options: ExecutionOptions | undefined): void {
  rejectActiveSignal(
    "The postgres.js adapter cannot cancel an active statement. A protocol cancel can reach a later statement on the same connection.",
    options,
  );
}

/** Wrap each hinted value with its type OID. postgres.js sends the OID in the Parse message. */
function typedValues(
  reserved: PostgresJsReservedLike,
  values: readonly unknown[],
  paramTypes: readonly number[] | undefined,
): readonly unknown[] {
  if (paramTypes === undefined) return values;
  const typed = reserved.typed;
  if (typeof typed !== "function") {
    throw unsupported(
      "statement.bind-hint",
      "BRAID_BIND_HINT_UNSUPPORTED",
      "The postgres.js reservation has no typed() function, so it cannot set a parameter type.",
    );
  }
  return values.map((value, index) => (paramTypes[index] ? typed.call(reserved, value, paramTypes[index]) : value));
}

/** Wrap one reserved postgres.js connection. The provider owns the reservation. */
function createPostgresJsExecutor(
  reserved: PostgresJsReservedLike,
  options: PostgresJsExecutorOptions = {},
): QueryExecutor {
  const policy = options.typePolicy ?? losslessPolicy;
  const batchSize = resolveStreamBatchSize(options.streamBatchSize);
  const runControl = async (text: string): Promise<void> => {
    const result = await reserved.unsafe(text, []);
    if (text === "COMMIT" && result.command != null && result.command !== "COMMIT") {
      throw new AdapterError(
        "BRAID_TX_NOT_COMMITTED",
        `PostgreSQL COMMIT completed with ${result.command}, not COMMIT.`,
      );
    }
  };
  return {
    ownershipKey: reserved,
    statementBinding: pgTypedStatementBinding,
    environment: losslessEnvironmentFor(driver, policy),
    async query<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      rejectSignal(executionOptions);
      const { text, values, paramTypes } = resolvePgBinding(rendered, binding, pgTypedStatementBinding);
      const result = await reserved
        .unsafe(text, typedValues(reserved, values, paramTypes), { prepare: false })
        .values();
      const fields = fieldsOf(result);
      assertUniqueFields(fields);
      const rows = projectPgRows(result, fields, policy);
      const rowCount =
        result.count === null || result.count === undefined ? undefined : safeDatabaseCount(result.count);
      const rowBearing = fields.length > 0 || result.length > 0 || result.command === "SELECT";
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
      const paramTypes = postgresParameterTypeOids(bulk.statement);
      let affectedRows = 0;
      let affectedKnown = true;
      for (let index = 0; index < binding.itemCount; index += 1) {
        // postgres.js owns the statement name and the reuse. It prepares each text once per connection.
        // oxlint-disable-next-line no-await-in-loop -- one connection runs one statement at a time
        const result = await reserved
          .unsafe(binding.parameterizedSql!, typedValues(reserved, binding.valuesAt(index), paramTypes), {
            prepare: true,
          })
          .values();
        if ((result.columns?.length ?? 0) > 0 || result.length > 0) {
          throw new Error("BRAID_BULK_RESULT_KIND: PostgreSQL bulk command returned rows.");
        }
        if (typeof result.count === "number") affectedRows += safeDatabaseCount(result.count);
        else affectedKnown = false;
      }
      return {
        inputCount: binding.itemCount,
        ...(affectedKnown ? { affectedRows: safeDatabaseCount(affectedRows) } : {}),
        executionMode: "prepared-loop",
      };
    },
    async *stream<Row>(
      rendered: RenderedStatement,
      binding?: StatementBindingDescription,
      executionOptions?: ExecutionOptions,
    ): AsyncGenerator<Row> {
      rejectSignal(executionOptions);
      const { text, values, paramTypes } = resolvePgBinding(rendered, binding, pgTypedStatementBinding);
      let project: ((value: unknown) => Record<string, unknown>) | undefined;
      // Leaving the loop early closes the cursor. The reserved connection stays usable.
      for await (const batch of reserved
        .unsafe(text, typedValues(reserved, values, paramTypes), { prepare: false })
        .values()
        .cursor(batchSize)) {
        const fields = fieldsOf(batch);
        assertUniqueFields(fields);
        if (fields.length === 0 && batch.length === 0) throw new DatabaseResultKindError("rows", "command");
        project ??= preparePgRowProjector(fields, policy);
        for (const row of batch) yield project(row) as Row;
      }
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
        "The postgres.js adapter does not implement routine calls.",
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

/**
 * Create a lease provider from a postgres.js client. Each lease is one reserved connection.
 * Create the client with `postgresJsOptions()`. A discarded lease resets the session before it returns to the pool,
 * because postgres.js does not expose the physical connection.
 */
export function createPostgresJsProvider(
  sql: PostgresJsLike,
  options: PostgresJsExecutorOptions = {},
): ConnectionProvider {
  assertPostgresJsLossless(sql);
  resolveStreamBatchSize(options.streamBatchSize);
  return {
    statementBinding: pgTypedStatementBinding,
    environment: losslessEnvironmentFor(driver, options.typePolicy ?? losslessPolicy),
    async acquire(): Promise<ConnectionLease> {
      // postgres.js never settles the first reserve() of a cold pool when fetch_types is off.
      await sql.unsafe("SELECT 1");
      const reserved = await sql.reserve();
      try {
        const executor = createPostgresJsExecutor(reserved, options);
        let released = false;
        return {
          ...executor,
          async release(releaseOptions = {}): Promise<void> {
            if (released) return;
            released = true;
            if (releaseOptions.discard === true) {
              try {
                await reserved.unsafe("ROLLBACK", []);
                await reserved.unsafe("DISCARD ALL", []);
              } catch (error) {
                // The session state is unknown. Keep the reservation instead of returning a dirty connection.
                throw cleanupAggregate(
                  [error],
                  "postgres.js session reset failed; the reservation was not released.",
                  error,
                );
              }
            }
            await reserved.release();
          },
        };
      } catch (error) {
        try {
          await reserved.release();
        } catch (cleanup) {
          throw cleanupAggregate([error, cleanup], "postgres.js reservation initialization cleanup failed.", error);
        }
        throw error;
      }
    },
  };
}

/** Wrap a postgres.js client as a pooled application database with one lease per root operation. */
export function createPostgresJsDatabase(sql: PostgresJsLike, options: PostgresJsDatabaseOptions = {}) {
  const { typePolicy, streamBatchSize, ...databaseOptions } = options;
  return createPooledDatabase(createPostgresJsProvider(sql, { typePolicy, streamBatchSize }), databaseOptions);
}
