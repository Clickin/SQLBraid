---
title: Driver-author binding guide
description: Implement a custom SQLBraid adapter without crossing the value-only boundary.
---

This guide is about custom `QueryExecutor`, `ConnectionProvider` and binding
adapters. It describes the current API. It does not give a support label or
publication evidence.

For labels, read the [runtime and driver support matrix](/SQLBraid/reference/support/).
Each label applies to one exact tuple of database, driver, profile, runtime and
capability, with its revision and workflow evidence. A neighboring version or a
package installation is not certification. The final exact-SHA Runtime, Docs and
Release gates and an explicit release authorization stay separate requirements.

The physical SPI accepts synchronous results. The application API stays asynchronous:

```ts
type Awaitable<T> = T | PromiseLike<T>;
```

`QueryExecutor.query`, `call`, the optional `bulk` and the transaction-control
methods can return `Awaitable`. `ConnectionProvider.acquire()` stays a `Promise`.
`stream()` stays `AsyncIterable`. Thus, a synchronous native iterator needs a
thin async-generator adapter. This keeps the cleanup and scope behavior.

## Logical statement invariant

Core/template rendering returns one immutable `RenderedStatement`:

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly nativeTemplate?: TemplateStringsArray;
  readonly dialectId: string;
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly routineProcedure?: RoutineProcedure;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

`segments.length === parameters.length + 1`. Each parameter is a value. A custom
driver must not read it as SQL, an identifier, nested SQL or a native
tagged-template command. Users write structural SQL with explicit helpers
(`sql.ident`, `sql.fragment`, `sql.raw`, `sql.list`, `sql.join`). It is already
in `segments`.

## Binding and leases

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
  describeBulk?(bulk: RenderedBulk, context: StatementBindingContext): BulkBindingDescription;
}
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
  validateTransactionOptions?(options: TransactionOptions): void;
  acquire(): Promise<ConnectionLease>;
}
interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}
```

`describe()` and `describeBulk()` are pure materialization before acquisition.

- Validate hints, shape and transport there.
- A materialization failure has both execution flags set to false.
- Providers and leases must expose the exact same immutable binding adapter
  object.
- Keep opaque driver requests private, for example in a `WeakMap` with
  `StatementBindingDescription` keys.

The logical prepared shape is the result kind, the dialect, the canonical
segments and the ordered hint, direction and output metadata. `$1`, `?`, `:1`
and `@p1` are transport details. They are not part of the shape identity. Values
can change. The structural shape cannot change.

## Executor methods and cancellation

```ts
interface QueryExecutor {
  readonly ownershipKey?: object;
  readonly statementBinding: StatementBindingAdapter;
  readonly environment?: DriverEnvironment;
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

- If the signal is already aborted, reject with its `reason`.
- An active signal requires a physical cancellation path. If there is no path,
  reject before I/O with `UnsupportedFeatureError`, the feature
  `statement.cancel` and `BRAID_CANCEL_UNSUPPORTED`. To stop the iteration alone
  is not cancellation.
- `stream` must be a real driver path.
- `call` must materialize and close each cursor, result set, request and carrier
  before the lease release.
- Never buffer to fake streaming. Never guess a routine carrier.

## Complete text-positional example

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
  execute<Row>(text: string, values: readonly unknown[]): Promise<QueryExecutionResult<Row>>;
  release(options?: { discard?: boolean }): void | Promise<void>;
}

const requests = new WeakMap<
  StatementBindingDescription,
  { statement: RenderedStatement; text: string; values: readonly unknown[] }
>();

function assertSignal(options?: ExecutionOptions): void {
  if (options?.signal?.aborted) throw options.signal.reason;
  if (options?.signal) {
    throw new UnsupportedFeatureError(
      "statement.cancel",
      "BRAID_CANCEL_UNSUPPORTED",
      "acme-wire cannot cancel an active statement",
    );
  }
}

export const acmeBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",
  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    if (statement.parameters.some((parameter) => parameter.hint !== undefined)) {
      throw new UnsupportedFeatureError("parameter.hint", "BRAID_BIND_HINT_UNSUPPORTED", "acme-wire has no hint API");
    }
    const binding = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder: (index) => `$${index}`,
      reuse: { effective: "simple", owner: "driver" },
    });
    const text = binding.parameterizedSql;
    if (text === undefined) throw new TypeError("BRAID_BIND_TRANSPORT: missing parameterized SQL");
    requests.set(binding, { statement, text, values: statement.parameters.map((parameter) => parameter.value) });
    return binding;
  },
});

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeBinding,
    async query<Row>(statement, binding, options) {
      assertSignal(options);
      statement = createRenderedStatement(statement);
      const description =
        binding ?? acmeBinding.describe(statement, { dialectId: statement.dialectId, requestedReuse: "auto" });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new TypeError("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.text, request.values);
    },
    stream(_statement, _binding, options): AsyncIterable<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError(
        "statement.stream",
        "BRAID_STREAM_UNSUPPORTED",
        "acme-wire has no stream protocol",
      );
    },
    async call(_statement, _binding, options): Promise<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError("routine.call", "BRAID_CALL_UNSUPPORTED", "acme-wire has no routine protocol");
    },
  };
}

export function createAcmeProvider(acquireClient: () => Promise<WireClient>): ConnectionProvider {
  return {
    statementBinding: acmeBinding,
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

## Capabilities and evidence

Use only the fixed transaction isolation literals and `readOnly`.

- Malformed runtime values fail with `TypeError` / `BRAID_TX_OPTIONS_INVALID`.
- Valid but unsupported options use `BRAID_TX_OPTION_UNSUPPORTED`.
- Nested explicit options use `BRAID_TX_OPTIONS_NESTED`.

The canonical capability keys are `statement.prepare`, `statement.stream`,
`statement.bulk`, `transaction`, `transaction.savepoint`, `routine.out`,
`routine.result-sets`, `routine.out-cursor` and `routine.return-value`.

Bun SQL uses one adapter family. The user must select
`dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`. The adapter does not
detect it automatically.

- Bun.SQL MySQL and MariaDB reject both explicit `readOnly` values before I/O,
  with `BRAID_TX_OPTION_UNSUPPORTED` / `transaction.read-only`. If you omit the
  option, the native session default stays.
- In Bun 1.3.14, a read-only failure can contaminate a connection after the
  rollback. Thus, contaminated reservations must be discarded.
- The access modes of Bun.SQL PostgreSQL and the representation-profile options
  do not change.

Deno can use an existing adapter where its public driver API works. Neither
statement promotes an unverified tuple of database, runtime and profile. For the
full checklist, read the [repository driver-author guide](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md).

For SQLite:

- `node:sqlite` and `better-sqlite3` can return synchronous physical results
  through `Awaitable`. The public database is still async. better-sqlite3 still
  blocks the event loop.
- Use `safeIntegers(true)` on each statement for exact INTEGER reads. Expose
  native iteration directly.
- The libSQL adapter requires an explicit `intMode: "string"` setting. It uses an
  interactive transaction handle. It does not claim pinned ordinary sessions. It
  must reject streaming when the selected client has no incremental cursor.
- Local libSQL evidence does not certify remote transports.
