# Diagnostics and error codes

> Stable SQLBraid codes and the boundary each one protects.

SQLBraid runtime/compiler errors expose a `code` where their error type defines
one. Thin adapter capability errors use `UnsupportedFeatureError` with a stable
`BRAID_*` code. Driver errors retain their original identity.

Binding construction failures (placeholder generation, hint mapping, typed
request construction, or unsupported transport selection) happen at
`materialize`, before lease acquisition or driver I/O. Driver/server/network
failures remain `driver`. Materialization errors have
`executionStarted === false` and `executionCompleted === false`.

The exported `PUBLIC_ERROR_DEFINITIONS` registry is the source of truth for
this reference. Runtime-owned classes include `DatabaseScopeError`,
`DatabaseResultKindError`, `DatabaseResultValidationError`,
`ResultExactnessError`, and `RoutineMappingError`. Adapter capability failures
use `UnsupportedFeatureError`; its `feature` identifies the capability and its
`code` is stable. Driver errors are not wrapped, and an already-aborted
`AbortSignal` rejects with its original `reason`.
Adapter input/transport failures use the `AdapterError` (`TypeError`) class
when they expose a stable bind code.

| Code                                   | Meaning                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAID_RESULT_EXACTNESS`               | A result value could not be represented without loss.                                                                                                                                                                 |
| `BRAID_RESULT_KIND`                    | Declared result kind disagreed with the adapter result after execution.                                                                                                                                               |
| `BRAID_RESULT_SETS_UNSUPPORTED`        | An ordinary query or stream returned an additional statement/result set; use `db.call()` for ordered routine sets.                                                                                                    |
| `BRAID_RESULT_VALIDATION`              | Query-bound or execution-level Standard Schema validation failed.                                                                                                                                                     |
| `BRAID_BATCH_ABORTED`                  | A batch item that had already announced `query:ready` was abandoned because another operation or shared batch phase failed. `executionStarted` and `executionCompleted` distinguish whether the item itself executed. |
| `BRAID_CALL_UNSUPPORTED`               | The adapter does not expose routine calls.                                                                                                                                                                            |
| `BRAID_STREAM_UNSUPPORTED`             | The adapter does not expose a streaming protocol.                                                                                                                                                                     |
| `BRAID_CANCEL_UNSUPPORTED`             | An active signal was supplied but the adapter cannot cancel the physical statement. Rejection occurs before I/O.                                                                                                      |
| `BRAID_SESSION_UNSUPPORTED`            | The adapter/provider cannot pin a session lease.                                                                                                                                                                      |
| `BRAID_SESSION_SCOPE`                  | The root database escaped an active session scope.                                                                                                                                                                    |
| `BRAID_SESSION_CLOSED`                 | A session callback handle was used after its callback ended.                                                                                                                                                          |
| `BRAID_TX_UNSUPPORTED`                 | The adapter cannot begin a transaction.                                                                                                                                                                               |
| `BRAID_TX_OPTIONS_INVALID`             | Runtime transaction options are malformed (`TypeError`); validation occurs before lease acquisition.                                                                                                                  |
| `BRAID_TX_OPTIONS_NESTED`              | Explicit transaction options were supplied inside an active transaction.                                                                                                                                              |
| `BRAID_TX_OPTION_UNSUPPORTED`          | A valid isolation/read-only option is not advertised; the feature identifies `transaction.isolation.<level>` or `transaction.read-only`.                                                                              |
| `BRAID_TX_SCOPE`                       | A root/parent/sibling transaction handle escaped the active scope.                                                                                                                                                    |
| `BRAID_TX_CLOSED`                      | A scoped transaction handle was used after its callback ended.                                                                                                                                                        |
| `BRAID_CONNECTION_POISONED`            | Uncertain transaction control poisoned the physical resource.                                                                                                                                                         |
| `BRAID_STREAM_SCOPE`                   | Streaming attempted overlapping or same-resource work.                                                                                                                                                                |
| `BRAID_REENTRY`                        | A direct physical resource was re-entered concurrently.                                                                                                                                                               |
| `BRAID_CALL_RESULT_SETS`               | A tuple routine declared a different result-set count than the driver returned.                                                                                                                                       |
| `BRAID_CALL_MAP`                       | Routine output, return value, or result-set row mapping failed.                                                                                                                                                       |
| `BRAID_CALL_CURSOR_TX_REQUIRED`        | A PostgreSQL refcursor call needs an existing transaction-scoped database.                                                                                                                                            |
| `BRAID_CALL_CURSOR_UNSUPPORTED`        | The adapter cannot expose the requested cursor output as an application result set.                                                                                                                                   |
| `BRAID_CALL_RETURN_UNSUPPORTED`        | A return/status schema was requested but no driver return/status channel exists.                                                                                                                                      |
| `BRAID_CALL_OUT_UNSUPPORTED`           | The adapter cannot expose the requested OUT or INOUT parameter carrier.                                                                                                                                               |
| `BRAID_CALL_LOB_UNSUPPORTED`           | Oracle output did not expose the documented LOB carrier.                                                                                                                                                              |
| `BRAID_RESOURCE_CLEANUP`               | Driver close, drain, or cancel failed; the physical lease is not safely reusable.                                                                                                                                     |
| `BRAID_PREPARED_NAME`                  | A prepared query name is empty or duplicated.                                                                                                                                                                         |
| `BRAID_PREPARED_SHAPE`                 | A prepared query rendered a different logical shape.                                                                                                                                                                  |
| `BRAID_PREPARE_UNSUPPORTED`            | The adapter cannot expose the required prepared-statement protocol.                                                                                                                                                   |
| `BRAID_BIND_HINT_UNSUPPORTED`          | The adapter cannot honor an explicit bind type/facet; rejection occurs before I/O.                                                                                                                                    |
| `BRAID_BIND_VALUE_UNSUPPORTED`         | A value cannot be represented by the selected binding transport.                                                                                                                                                      |
| `BRAID_BIND_TYPE_REQUIRED`             | Driver inference is ambiguous, including untyped null in Oracle or SQL Server.                                                                                                                                        |
| `BRAID_INTEGER_MODE_UNSUPPORTED`       | The adapter cannot enable the exact integer read mode required by its contract.                                                                                                                                       |
| `BRAID_BULK_UNSUPPORTED`               | The adapter does not expose the required native bulk capability.                                                                                                                                                      |
| `BRAID_DIALECT_MISMATCH`               | A rendered statement belongs to a different selected adapter dialect.                                                                                                                                                 |
| `BRAID_RESULT_KIND_AMBIGUOUS`          | The adapter cannot distinguish an empty row result from a command result.                                                                                                                                             |
| `BRAID_EMPTY_LIST`                     | `sql.list([])` was used without an explicit empty strategy.                                                                                                                                                           |
| `BRAID_EMPTY_SET`                      | `@braid set` rendered no assignment.                                                                                                                                                                                  |
| `BRAID_DIALECT`                        | A fragment belongs to a different dialect.                                                                                                                                                                            |
| `BRAID_ASYNC_CONTEXT`                  | Guarded lowering would change top-level await/yield evaluation context.                                                                                                                                               |
| `BRAID_DIRECTIVE_UNTERMINATED`         | A directive comment is missing its closing `*/`.                                                                                                                                                                      |
| `BRAID_DIRECTIVE`                      | An `@braid` directive is empty or unknown.                                                                                                                                                                            |
| `BRAID_CONDITION`                      | A guard does not contain exactly one interpolation with no additional text.                                                                                                                                           |
| `BRAID_ATTRIBUTES`                     | Directive attributes are unsupported, malformed, or duplicated.                                                                                                                                                       |
| `BRAID_STRUCTURE`                      | Directive nesting or branch structure is invalid.                                                                                                                                                                     |
| `BRAID_HOLE_CONTEXT`                   | An interpolation appears inside a SQL literal or comment.                                                                                                                                                             |
| `BRAID_SQL_LEX`                        | A SQL literal or comment is unterminated.                                                                                                                                                                             |
| `BRAID_DEPTH`                          | Template or rendered-fragment nesting exceeds its configured limit.                                                                                                                                                   |
| `BRAID_STRUCTURE_LIMIT`                | Rendered structural items exceed `maxStructuralItems`.                                                                                                                                                                |
| `BRAID_SQL_LIMIT` / `BRAID_BIND_LIMIT` | Rendered output exceeds configured limits.                                                                                                                                                                            |

`UnsupportedFeatureError` has `(feature, code, message, options?)`; its code is
constrained to `BRAID_${string}`. An already-aborted signal rejects with its
`reason`, not with `BRAID_CANCEL_UNSUPPORTED`. Do not catch an unsupported
capability and replace it with buffering, a hidden transaction, guessed routine
metadata, or ignored hints.

Compiler diagnostics include source range and severity. CLI JSON uses 1-based
positions; LSP uses standard 0-based positions. Missing metadata is open-world
evidence, not an invalid-SQL error.
