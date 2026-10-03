# Driver-author guide

This guide is for authors of a custom `QueryExecutor`, a custom `ConnectionProvider` or an adapter in the first-party style. It documents the current phase-J SPI. It is not a support claim and not a release claim.

The last exact-SHA verification was revision `8da8167e027320fcc9bb2aac16b0903c64147940` (Runtime [34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046), Docs [34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102), Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)). The current tree requires new evidence.

`QueryExecutor` accepts synchronous results only at the physical boundary:

```ts
type Awaitable<T> = T | PromiseLike<T>;
```

`query`, `call`, `bulk` and the transaction-control methods can return an
`Awaitable`. The public `Database` API stays asynchronous.
`ConnectionProvider.acquire()` stays a `Promise`. Thus, a synchronous driver
does not need a Promise wrapper, and the application API stays asynchronous.

`stream()` stays `AsyncIterable`. To adapt a synchronous iterator, use a thin
async generator. Then the cleanup and scope semantics do not change.

## 1. Preserve the logical statement boundary

Core/template rendering returns one immutable `RenderedStatement`:

```ts
interface RenderedParameter {
  readonly value: unknown;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
  readonly direction?: "in" | "out" | "inout";
  readonly outputName?: string;
}

interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly dialectId: string;
  readonly routineProcedure?: {
    readonly name: string;
    readonly parameterNames: readonly string[];
  };
}
```

The invariant is `segments.length === parameters.length + 1`. Structural SQL is already in `segments`. Each rendered parameter is a value.

- Do not read a parameter as SQL, an identifier, a nested query, a driver fragment or a tagged-template command.
- Call `createRenderedStatement` at a public boundary.
- Do not keep mutable parallel arrays of SQL, values or hints as a second source of truth.

## 2. Materialize through the binding SPI

The adapter owns placeholders, typed requests and reuse:

```ts
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}

interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
  readonly describeBulk?: (bulk: RenderedBulk, context: StatementBindingContext) => BulkBindingDescription;
}
```

`describe` and `describeBulk` are pure with respect to the database. They must validate hints and build deterministic transport metadata before lease acquisition.

- A materialization failure has the stage `"materialize"`, with `executionStarted === false` and `executionCompleted === false`.
- Driver, server and network failures keep the stage `"driver"`.

The provider and each lease must expose the exact same `statementBinding` object:

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  validateTransactionOptions?(options: TransactionOptions): void;
  acquire(): Promise<ConnectionLease>;
}

interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}
```

This identity check prevents a lease from silently changing the rules for the
dialect, placeholders or value encoding. A provider is a source of leases. It is
not a physical executor. Keep opaque driver requests private to the adapter, for
example in a `WeakMap<StatementBindingDescription, OpaqueRequest>`.

The identity of a prepared shape is logical. It contains the result kind,
canonical segments, dialect, ordered hints, directions, output names and the
related procedure metadata. `$1`, `?`, `:1` and `@p1` are transport details. A
prepared execution does these steps:

1. It renders once.
2. It validates the shape.
3. It describes the binding.
4. It executes the statement.

`StatementBindingContext` can contain `preparedName`. This is a SQLBraid logical
name. Its scope is the live `Database` handle that created the prepared query.
It is not a globally reserved name. It is not a promise that the server or the
driver uses the same string as a prepared-statement name.

If an adapter maps names to native statements, it must obey these rules:

- Derive a native identity that cannot collide, from the scope or handle state
  of the adapter. Or use unnamed reuse or reuse that the driver owns.
- Different live SQLBraid prepared handles that repeat a logical name must not
  alias one another.
- Different logical shapes must not accidentally use the same native statement.
- Keep that identity private. Keep the meaning of the logical name for the
  application.

The supported boundary for SPI implementers is the executor, provider, lease and
binding interfaces above, and the documented observer interfaces. Existing
required members stay source-compatible across 1.x. To add a new driver
capability, use optional members or capabilities, or a separate extension
interface. Do not add a new required method for one adapter. Keep these items:

- the argument order `(statement, binding?, options?)` and the trailing options;
- the immutable binding identity of the provider and the lease;
- explicit unsupported errors;
- the ownership of cleanup.

## 3. Executor interface and options

Each executor method uses the same convention for trailing options:

```ts
interface QueryExecutor {
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  query<Row>(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<QueryExecutionResult<Row>>;
  stream<Row>(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): AsyncIterable<Row>;
  call(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<DriverRoutineResult>;
  bulk?(
    bulk: RenderedBulk,
    binding: BulkBindingDescription,
    options?: ExecutionOptions,
  ): Awaitable<BulkExecutionResult>;
  validateTransactionOptions?(options: TransactionOptions): void;
  begin?(options?: TransactionOptions): Awaitable<void>;
  commit?(): Awaitable<void>;
  rollback?(): Awaitable<void>;
  savepoint?(name: string): Awaitable<void>;
  rollbackTo?(name: string): Awaitable<void>;
  releaseSavepoint?(name: string): Awaitable<void>;
}
```

`validateTransactionOptions?` is an optional policy hook. It is synchronous and
pure.

- If it is present, it decides which exact transaction options the adapter
  permits.
- It must not acquire a resource, do I/O, change the transaction state or do
  asynchronous work.
- `begin()` must use the same validator. Do not keep a second set of option
  rules.
- A `ConnectionProvider` can expose the same hook. If the policy can be
  different for each lease, each lease must expose equivalent validation.
- The runtime does not require the same function identity. If a lease omits the
  hook, the runtime uses the validator of the provider.
- Without the hook, the runtime keeps the conservative option checks that use
  capabilities.

The generic capability checks for transactions and savepoints still apply
independently.

`ExecutionOptions` contains `signal?: AbortSignal`. Row validation options add
`schema`. Stream options add the same schema and the signal.

- If the signal is already aborted, reject with its `reason`.
- An active signal requires a real cancellation path in the adapter.
- If the adapter cannot cancel a statement that is in progress, reject before
  I/O with `UnsupportedFeatureError` and `BRAID_CANCEL_UNSUPPORTED`. Do not only
  stop the yield of rows while the driver continues.

In the same way, if the prepared-statement protocol is unavailable, use
`statement.prepare` with `BRAID_PREPARE_UNSUPPORTED`. Do not use
`BRAID_BULK_UNSUPPORTED`. That code is reserved for `statement.bulk`.

## 4. Routine and bulk results

`call()` returns materialized, normalized data. Before the lease release, it must read and close all cursors, result sets, requests, LOBs and protocol carrier resources:

```ts
interface DriverRoutineResult {
  readonly output: Readonly<Record<string, unknown>>;
  readonly resultSets: readonly {
    readonly rows: readonly unknown[];
    readonly source:
      | { readonly kind: "out-cursor"; readonly name?: string; readonly parameterIndex?: number }
      | { readonly kind: "implicit"; readonly index: number }
      | { readonly kind: "emitted"; readonly index: number };
  }[];
  readonly returnValue?: unknown;
}
```

A cursor OUT belongs in `resultSets`. It does not belong in the scalar `output`. Do not expose native cursors, portals, requests, packets or mutable driver rows.

`db.bulk(inputs, factory)` is for commands only and is homogeneous. The runtime does these steps:

1. It renders each item.
2. It locks the first logical shape.
3. It validates the complete value matrix and the binding description. This occurs before it acquires a lease.
4. It calls the optional `bulk` method once, on one lease.

Empty input does not acquire a lease. Root bulk is not a transaction and does not split the input into chunks automatically. Report the actual execution mode: `native-bulk`, `pipeline`, `prepared-loop` or `remote-batch`. Do not claim atomicity from a mode name.

## 5. Complete text-positional example

This adapter supports only materialized queries. This is intentional. It rejects active cancellation before I/O. It rejects stream and call explicitly. It does not buffer or guess.

```ts
import {
  UnsupportedFeatureError,
  createRenderedStatement,
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type ExecutionOptions,
  type QueryExecutionResult,
  type QueryExecutor,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingContext,
  type StatementBindingDescription,
} from "@sqlbraid/core";
interface WireClient {
  execute<Row>(sql: string, values: readonly unknown[]): Promise<QueryExecutionResult<Row>>;
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

const requests = new WeakMap<
  StatementBindingDescription,
  {
    readonly statement: RenderedStatement;
    readonly sql: string;
    readonly values: readonly unknown[];
  }
>();

function assertSignal(options?: ExecutionOptions): void {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  if (signal) {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "The acme-wire adapter cannot cancel an active statement.",
    );
  }
}

function placeholder(index: number): string {
  return `$${index}`;
}

export const acmeStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    for (const parameter of statement.parameters) {
      if (parameter.hint !== undefined) {
        throw new UnsupportedFeatureError(
          "parameter.hint",
          "BRAID_BIND_HINT_UNSUPPORTED",
          "The acme-wire adapter has no database hint API.",
        );
      }
    }
    const description = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder,
      reuse: { effective: "simple", owner: "driver" },
    });
    const sql = description.parameterizedSql;
    if (sql === undefined) throw new TypeError("BRAID_BIND_TRANSPORT: parameterized SQL is required.");
    requests.set(description, {
      statement,
      sql,
      values: statement.parameters.map((parameter) => parameter.value),
    });
    return description;
  },
});

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeStatementBinding,

    async query<Row>(
      statement: RenderedStatement,
      binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<QueryExecutionResult<Row>> {
      assertSignal(options);
      statement = createRenderedStatement(statement);
      const description =
        binding ??
        acmeStatementBinding.describe(statement, {
          dialectId: statement.dialectId,
          requestedReuse: "auto",
        });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new TypeError("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.sql, request.values);
    },

    stream<Row>(
      _statement: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): AsyncIterable<Row> {
      assertSignal(options);
      throw new UnsupportedFeatureError(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "The acme-wire adapter has no streaming protocol.",
      );
    },

    async call(
      _statement: RenderedStatement,
      _binding?: StatementBindingDescription,
      options?: ExecutionOptions,
    ): Promise<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError(
        "routine.call",
        "BRAID_CALL_UNSUPPORTED",
        "The acme-wire adapter has no routine protocol.",
      );
    },
  };
}

export function createAcmeProvider(acquireClient: () => Promise<WireClient>): ConnectionProvider {
  return {
    statementBinding: acmeStatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const client = await acquireClient();
      const executor = createAcmeExecutor(client);
      let released = false;
      return {
        ...executor,
        async release(options) {
          if (released) return;
          released = true;
          await client.release(options);
        },
      };
    },
  };
}
```

The example has no hidden fallback:

- `query` is the only implemented operation.
- `stream` and `call` return stable unsupported errors.
- An active `AbortSignal` is rejected as unsupported before `WireClient.execute`.

A real adapter can replace those stubs only after it implements and tests the
cleanup and cancellation semantics of the related protocol.

## 6. Transaction and environment capabilities

Implement `begin(options)` only for the options that the physical connection
can obey. The portable isolation strings are `read-uncommitted`,
`read-committed`, `repeatable-read` and `serializable`.

- An unsupported option must throw `UnsupportedFeatureError` with a `BRAID_*`
  code. The runtime uses `BRAID_TX_OPTION_UNSUPPORTED`.
- Nested explicit transaction options are rejected. Do not acquire again for
  `tx` inside a session.
- If the permitted options depend on the adapter or the profile, expose the
  optional synchronous `validateTransactionOptions` hook on the executor and the
  provider. Call the same pure validator from `begin()`.
- A provider that exposes the hook must keep an equivalent policy on its
  leases. If a lease omits the optional member, the runtime can use the
  validator of the provider. A check of the function identity is not necessary.

A native control call that is fulfilled is not always a successful transaction.
If the driver exposes terminal command metadata, inspect it.

- If PostgreSQL `COMMIT` reports `ROLLBACK`, reject. Do not return the value of
  the callback.
- Propagate asynchronous errors from savepoint callbacks.
- A failed recovery must not permit an outer commit or the reuse of the
  resource as healthy.
- When a rollback or cleanup fails, keep the original callback error with it.

The access mode has three states:

- If you omit it, the session default stays.
- `true` selects read-only.
- `false` explicitly selects read-write, where the adapter supports it.

During a transaction that SQLBraid owns, the auto-commit of the driver or of a
global statement cannot take control of the transaction boundary.

Bun.SQL MySQL and MariaDB explicitly reject both boolean `readOnly` values
before I/O, with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`. Native
Bun 1.3.14 can keep the shape of a failed read-only statement after a rollback
and a later explicit read-write begin. Thus, a successful rollback alone does not
prove that the resource is safe to reuse.

- Contaminated reservations must be discarded. Do not return them as healthy,
  and do not replace them under an active session.
- If you omit the access mode, the native session default stays.
- This restriction does not apply to Bun.SQL PostgreSQL. It does not change the
  representation-profile options.

Environment capability IDs are canonical and come from capabilities. The full
machine-readable vocabulary is exported from `@sqlbraid/core` as
`WELL_KNOWN_CAPABILITIES`. `support/capabilities.json` copies it. Its families
keep execution support separate from representation evidence and metadata
evidence:

<!-- sqlbraid-capability-vocabulary -->

```text
# support
sql.native-transparency
sql.generated-structure
result.rows
result.command
result.multiple-sets
result.standard-schema
dml.insert-returning
dml.update-returning
dml.delete-returning
dml.merge-returning
dml.upsert-returning
session.pinned
statement.prepare
statement.cancel
statement.stream
statement.bulk
execution.bulk-fidelity
transaction
transaction.savepoint
transaction.read-only
transaction.isolation.read-uncommitted
transaction.isolation.read-committed
transaction.isolation.repeatable-read
transaction.isolation.serializable
routine.call
routine.out
routine.inout
routine.result-sets
routine.out-cursor
routine.return-value

# representation
numeric.exact-integer
numeric.exact-decimal
numeric.approximate-float
numeric.approximate-special
numeric.bind-exact
numeric.aggregate
numeric.command-metadata
numeric.special-values
numeric.scale-greater-than-precision
numeric.negative-scale
data.json-parsed
data.json-lossless-text
data.sql-variant
data.oracle-object
data.oracle-collection
data.vector
data.binary
data.uuid
data.temporal-native
data.temporal-lossless
data.timezone

# metadata
metadata.command-safe
metadata.identity
metadata.generated
metadata.routines
metadata.types
```

Do not publish aliases. Do not infer a capability from a dialect name. For
support labels, use executable evidence for the database, driver, runtime and
profile. A Bun adapter can support several dialects that the user selects. It
does not detect one automatically. Deno can use an existing adapter where its
public driver API works. Neither statement creates a new dialect or promotes an
unverified tuple.

## 7. SQLite driver notes

SQLite stays one dialect with transports for each driver.

- The synchronous `node:sqlite` and `better-sqlite3` adapters return plain
  values from the physical query, bulk and transaction-control methods. Their
  public databases stay async.
- `better-sqlite3` uses `safeIntegers(true)` on each statement, native
  `iterate()` for streams and a prepared loop for bulk. These calls still block
  the JavaScript event loop. `Awaitable` does not give background execution.

The libSQL adapter requires an explicit `{ intMode: "string" }` assertion before
it builds the database.

- It classifies results with `columns`, `rows`, `rowsAffected` and a trustworthy
  remote `lastInsertRowid`.
- It uses `client.batch()` for bulk.
- It sends an active transaction through the documented interactive
  Transaction handle.
- Ordinary client calls do not prove a pinned session. Thus, `session.pinned`
  stays unsupported.
- There is no documented incremental cursor. Thus, `statement.stream` is
  unsupported. The adapter does not implement it with a buffer.

These are implementation facts. They are not broad support labels. Record the
evidence for the exact driver version, runtime, profile and transport
separately. Local libSQL evidence does not certify remote HTTP or WebSocket
clients.

Local `file:` clients and clients with an unknown protocol omit the optional
command `insertId`. The pinned native binding rounds ROWID through Number before
it produces its bigint. `intMode: "string"` sets only the row representation. It
does not set the fidelity of command metadata. Keep successful mutations and
affected-row counts usable. Do not throw after committed I/O because ID metadata
is unavailable. To get exact IDs, request them in `RETURNING` row results in
your SQL.
