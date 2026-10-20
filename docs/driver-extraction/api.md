# Experimental driver interface

The provisional package is `@execution-lab/driver`, version `0.0.0-experiment`.
It is private and lives in `experiments/driver-extraction`.
No name, version, or interface stability is promised.

Run the packed standalone examples with `pnpm run test:driver-extraction`.
The runner builds a separate consumer installation from the tarball.
It does not use TypeScript aliases or import the SQLBraid facade or template package.

## Selected design: minimal physical SPI

These are interface sketches. The source in `experiments/driver-extraction/src/types.ts` is authoritative.

<!-- doc-snippet: skip -->

```ts
interface Statement {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
}

interface Result<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly columns: readonly unknown[];
  readonly affectedRows?: number | bigint;
  readonly insertId?: number | bigint;
  readonly command?: string;
}

interface TransactionOptions {
  readonly isolation?: "read-uncommitted" | "read-committed" | "repeatable-read" | "serializable";
  readonly readOnly?: boolean;
}

interface Connection {
  readonly capabilities: Capabilities;
  execute<Row = Record<string, unknown>>(
    statement: Statement,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<Row>>;
  begin(options?: TransactionOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(options?: { readonly discard?: boolean }): Promise<void>;
}

interface Provider {
  readonly capabilities: Capabilities;
  acquire(): Promise<Connection>;
}
```

Factories are `pgConnection(client)`, `pgPool(pool)`, and `sqliteConnection(database)`.
The caller opens a native client, pool, or database first.
The factories accept structural native interfaces. The package does not install native drivers.
`execute<Row>` is a caller declaration. It does not validate the returned values.

A statement contains native placeholders: `$1` for pg and `?` for SQLite.
The package neither rewrites placeholders nor interpolates values into SQL.
An empty parameter list is permitted. An `undefined` parameter is rejected.
Named parameters, typed requests, native templates, and SQLBraid hints are outside this first slice.
Do not emulate those transports by string replacement.

## Ownership and concurrency

| Resource                    | Owner                                                               | End of ownership                                                 |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Direct pg connection        | Experimental connection after successful construction               | `release()` calls native `end()`                                 |
| Direct node:sqlite database | Experimental connection after successful construction               | `release()` calls native `close()`                               |
| Borrowed pg pool client     | One acquired experimental connection                                | `release()` returns client, or discards it                       |
| Pool itself                 | Caller                                                              | Caller calls native pool shutdown after all leases finish        |
| Transaction                 | Same exclusive connection from `begin()` through commit or rollback | Successful control operation, then optional lease release        |
| Session                     | Consumer retains the same lease; no separate session facade         | Consumer releases lease                                          |
| Stream-held connection      | Not implemented in this experiment                                  | A future extension must close its native iterator before release |
| Poisoned connection         | Current lease, for cleanup only                                     | Discard or close; never advertise reuse                          |

Await each operation. The minimal SPI rejects overlap with `BUSY`; it does not queue work.
This includes a release racing with a query. Retry release after the query settles.
Construction rejects a second live experimental wrapper for the same physical object.
Do not use the raw client or another library concurrently with its experimental wrapper.
The library cannot intercept raw native calls.

Use the transaction methods for transaction control. Do not send `BEGIN`, `COMMIT`, or `ROLLBACK` through `execute()`.
The package deliberately has no SQL parser to detect control statements.
This restriction also applies to native transaction calls made behind the wrapper.

`begin()` rejects nesting. Savepoints are not silently substituted.
An execution error inside a transaction requires rollback before another statement or commit.
This is conservative for SQLite, where some statement failures do not abort the transaction.
A failed control operation poisons the connection because the server state can be uncertain.
Rollback remains available for cleanup. Successful rollback does not clear poisoning.

`release()` rolls back an unfinished transaction before returning or closing the resource.
If rollback fails, it still attempts release with discard.
Release is terminal and idempotent. Repeated release returns the same outcome.
A release failure does not make the wrapper usable again.
An explicit discard always reaches the pool's native discard operation.

SQLBraid retains its existing queues, async-context escape checks, session handles, stream tracking,
and poison state. It does not use this experimental wrapper to replace its lifecycle.
Only the native dispatch implementation is shared with the stable adapters.

## Native values and metadata

The common layer does not decode values, copy rows, attach metadata to each row, or enforce exact numeric strings.
Column metadata belongs to the result envelope.
Consumers can use driver-specific type identifiers when the native driver supplies them.
Metadata remains driver-specific; the first slice does not invent a universal SQL type catalog.

- pg uses the parsers configured on the native client. Object rows and native field records pass through.
- node:sqlite uses native statement defaults in the independent path.
- SQLBraid configures its existing parser overrides and SQLite bigint/array modes before projection.
- SQLBraid keeps duplicate-label rejection and its current result representations.
- The independent object-row path retains native duplicate-label behavior. It cannot recover overwritten values.
- A generic TypeScript row type is not evidence that transport preserved precision.
- A consumer needing exact SQLite int64 values must not infer fidelity from default Number reads.

SQLBraid's string conversion is not moved below the seam.
A consumer can configure its native pg parsers or transform native results itself.
A common configurable decoding framework is not implemented.
The SQLite materializer's configuration hooks exist to preserve SQLBraid's native read mode,
not to define a new application codec system.

Affected-row counts and generated identifiers remain optional and retain native numeric types.
Do not infer affected rows from a returned array length.
Do not infer generated identifiers from a selected column.
A consumer must range-check a Number before converting it into an exact bigint count.

## Capabilities and extensions

The implemented capabilities record has `driver`, `parameters`, and `transactions` fields.
Its `streaming`, `cancellation`, `prepared`, `savepoints`, `bulk`, `routines`, and `multipleResults` fields are false.
Those fields describe this wrapper, not the full capabilities of pg or SQLite.

These optional interface shapes illustrate future extensions. They are not implemented exports.

<!-- doc-snippet: skip -->

```ts
interface StreamingConnection {
  stream(statement: Statement): AsyncIterable<Result>;
}
interface SavepointConnection {
  savepoint(name: string): Promise<void>;
  rollbackTo(name: string): Promise<void>;
  releaseSavepoint(name: string): Promise<void>;
}
interface PreparedConnection {
  prepare(statement: Statement): Promise<{
    execute(parameters: readonly unknown[]): Promise<Result>;
    close(): Promise<void>;
  }>;
}
```

Do not add required empty methods for unavailable features.
A future stream owns the lease until iterator return and cleanup complete.
Cancellation must interrupt native work or reject before execution.
A rejected JavaScript promise is not database cancellation.
Cancellation that destroys a client must force discard before pool reuse.
Bulk, routines, OUT parameters, result sets, inspectors, and vendor extensions need separate concrete evidence.

## Errors

`DriverError.code` is one of `UNSUPPORTED`, `BUSY`, `CLOSED`, `TRANSACTION_STATE`, or `POISONED`.
Input shape failures use `TypeError`. Native driver failures retain their original object and database code.
Rollback and release failures use `AggregateError` when both occur; the rollback error is the primary cause.
Callers must preserve an execution error if their later cleanup also fails.
The standalone examples demonstrate cleanup without treating a failed operation as success.

An already-aborted signal rejects with its reason before native execution.
A live signal rejects with `UNSUPPORTED` before execution because this slice has no cancellation implementation.
Unsupported transaction options reject before native control statements.
A PostgreSQL commit response that reports rollback is not accepted as a successful commit.
Multiple-result rejection occurs after native execution. It cannot undo side effects from the submitted SQL.

## Alternative managed interface

This alternative is not implemented.

<!-- doc-snippet: skip -->

```ts
interface ManagedExecution {
  execute(statement: Statement): Promise<Result>;
  transaction<T>(run: (connection: Connection) => Promise<T>, options?: TransactionOptions): Promise<T>;
  session<T>(run: (connection: Connection) => Promise<T>): Promise<T>;
}
```

A real implementation would also need nested-scope policy, handle expiry, async context,
stream ownership, mapping boundaries, and cleanup-error aggregation.
The small signature does not make those responsibilities small.
Kysely already owns much of that lifecycle. The selected SPI leaves orchestration with its consumer.
