# Driver-author binding guide

> Implement a custom SQLBraid adapter without crossing the value-only boundary.

This guide covers custom `QueryExecutor`, `ConnectionProvider`, and binding
adapters. It describes the current API contract; it does not grant a support
label or publication evidence. Consult the [runtime and driver support
matrix](/SQLBraid/v/1.0.0-rc.2/reference/support.md) for labels scoped to the exact
database/driver/profile/runtime/capability tuple and its revision and workflow
evidence. A neighboring version or package installation is not certification.
Final exact-SHA Runtime, Docs, and Release gates and explicit release
authorization remain separate requirements.

The physical SPI is sync-aware without creating a synchronous application API:

```ts
type Awaitable<T> = T | PromiseLike<T>;
```

`QueryExecutor.query`, `call`, optional `bulk`, and transaction-control methods
may return `Awaitable`; `ConnectionProvider.acquire()` remains a `Promise`.
`stream()` remains `AsyncIterable`, so a synchronous native iterator needs a
thin async-generator adapter to preserve cleanup and scope behavior.

## Logical statement invariant

Core/template rendering returns one immutable `RenderedStatement`:

```ts
interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: "rows" | "command" | "call" | "unknown";
  readonly dialectId: string;
}
```

`segments.length === parameters.length + 1`. Every parameter is a value. A
custom driver must not reinterpret it as SQL, an identifier, nested SQL, or a
native tagged-template command. Structural SQL is authored through explicit
helpers (`sql.ident`, `sql.fragment`, `sql.raw`, `sql.list`, `sql.join`) and is
already present in `segments`.

## Binding and leases

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
}
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
interface ConnectionLease extends QueryExecutor {
  release(options?: { discard?: boolean }): void | Promise<void>;
}
```

`describe()` and `describeBulk()` are pure pre-acquire materialization. Validate
hints, shape, and transport there; materialization failure has both execution
flags false. Providers and leases must expose the exact same immutable binding
adapter object. Keep opaque driver requests private, for example in a `WeakMap`
keyed by `StatementBindingDescription`.

Logical prepared shape is result kind, dialect, canonical segments, and ordered
hint/direction/output metadata. `$1`, `?`, `:1`, and `@p1` are transport details,
not shape identity. Values may change; structural shape may not.

## Executor methods and cancellation

```ts
interface QueryExecutor {
  readonly statementBinding: StatementBindingAdapter;
  query<Row>(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Awaitable<QueryExecutionResult<Row>>;
  stream<Row>(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): AsyncIterable<Row>;
  call(statement: RenderedStatement, binding?: StatementBindingDescription, options?: ExecutionOptions): Awaitable<DriverRoutineResult>;
  bulk?(bulk: RenderedBulk, binding: BulkBindingDescription, options?: ExecutionOptions): Awaitable<BulkExecutionResult>;
  begin?(options?: TransactionOptions): Awaitable<void>;
  commit?(): Awaitable<void>;
  rollback?(): Awaitable<void>;
  savepoint?(name: string): Awaitable<void>;
  rollbackTo?(name: string): Awaitable<void>;
  releaseSavepoint?(name: string): Awaitable<void>;
}
```

An already-aborted signal rejects with its `reason`. An active signal requires a
physical cancellation path. Without one, reject before I/O with
`UnsupportedFeatureError`, feature `statement.cancel`, and
`BRAID_CANCEL_UNSUPPORTED`; stopping iteration alone is not cancellation.
`stream` must be a real driver path, and `call` must materialize/close every
cursor, result set, request, and carrier before lease release. Never buffer to
fake streaming or guess a routine carrier.

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

const requests = new WeakMap<StatementBindingDescription, { statement: RenderedStatement; text: string; values: readonly unknown[] }>();

function assertSignal(options?: ExecutionOptions): void {
  if (options?.signal?.aborted) throw options.signal.reason;
  if (options?.signal) {
    throw new UnsupportedFeatureError("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", "acme-wire cannot cancel an active statement");
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
      const description = binding ?? acmeBinding.describe(statement, { dialectId: statement.dialectId, requestedReuse: "auto" });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new TypeError("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.text, request.values);
    },
    stream(_statement, _binding, options): AsyncIterable<never> {
      assertSignal(options);
      throw new UnsupportedFeatureError("statement.stream", "BRAID_STREAM_UNSUPPORTED", "acme-wire has no stream protocol");
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
      return { ...executor, async release(options) { if (released) return; released = true; await client.release(options); } };
    },
  };
}
```

## Capabilities and evidence

Use only the fixed transaction isolation literals and `readOnly`; malformed
runtime values fail with `TypeError` / `BRAID_TX_OPTIONS_INVALID`, valid but
unsupported options use `BRAID_TX_OPTION_UNSUPPORTED`, and nested explicit
options use `BRAID_TX_OPTIONS_NESTED`. Canonical capability keys are
`statement.prepare`, `statement.stream`, `statement.bulk`, `transaction`,
`transaction.savepoint`, `routine.out`, `routine.result-sets`,
`routine.out-cursor`, and `routine.return-value`.

Bun SQL uses one adapter family with required user-selected
`dialect: "postgres" | "mysql" | "mariadb" | "sqlite"`; it does not auto-detect.
Deno may reuse an existing adapter where its public driver API works. Neither
statement promotes an unverified database/runtime/profile tuple. For the full
checklist, see the [repository driver-author guide](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md).

For SQLite, `node:sqlite` and `better-sqlite3` may return synchronous physical
results through `Awaitable`; the public database is still async and
better-sqlite3 still blocks the event loop. Use statement-local
`safeIntegers(true)` for exact INTEGER reads and expose native iteration
directly. The libSQL adapter requires an explicit `intMode: "string"` contract,
uses an interactive transaction handle, does not claim pinned ordinary
sessions, and must reject streaming when the selected client has no incremental
cursor. Local libSQL evidence does not certify remote transports.
