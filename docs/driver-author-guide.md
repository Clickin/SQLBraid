# Driver-author guide

This guide is for a custom `QueryExecutor`, `ConnectionProvider`, or first-party-style adapter. It documents the current phase-J SPI; it is not a support or release claim. The last exact-SHA verification was revision `8da8167e027320fcc9bb2aac16b0903c64147940` (Runtime [34856051046](https://github.com/Clickin/SQLBraid/actions/runs/34856051046), Docs [34856051102](https://github.com/Clickin/SQLBraid/actions/runs/34856051102), Release [34856063326](https://github.com/Clickin/SQLBraid/actions/runs/34856063326)). The current tree requires new evidence.

`QueryExecutor` is sync-aware only at the physical boundary:

```ts
type Awaitable<T> = T | PromiseLike<T>;
```

`query`, `call`, `bulk`, and transaction-control methods may return an
`Awaitable`. The public `Database` API remains asynchronous, and
`ConnectionProvider.acquire()` remains a `Promise`. This lets synchronous
drivers avoid a needless Promise wrapper without exposing a synchronous
application API. `stream()` remains `AsyncIterable`; adapt a synchronous
iterator with a thin async generator so cleanup and scope semantics stay
unchanged.

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

The invariant is `segments.length === parameters.length + 1`. Structural SQL is already in `segments`; every rendered parameter is a value. Never reinterpret a parameter as SQL, an identifier, a nested query, a driver fragment, or a tagged-template command. Call `createRenderedStatement` at a public boundary and do not retain mutable parallel SQL/value/hint arrays as another source of truth.

## 2. Materialize through the binding SPI

The adapter owns placeholders, typed requests, and reuse:

```ts
interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}

interface StatementBindingAdapter {
  readonly id: string;
  describe(
    statement: RenderedStatement,
    context: StatementBindingContext,
  ): StatementBindingDescription;
  readonly describeBulk?: (
    bulk: RenderedBulk,
    context: StatementBindingContext,
  ) => BulkBindingDescription;
}
```

`describe` and `describeBulk` are pure with respect to the database. They must validate hints and construct deterministic transport metadata before lease acquisition. A materialization failure is reported at stage `"materialize"` with `executionStarted === false` and `executionCompleted === false`. Driver/server/network failures remain stage `"driver"`.

The provider and every lease must expose the exact same `statementBinding` object:

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}

interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}
```

This identity check prevents a lease from silently changing dialect, placeholder, or value-encoding rules. A provider is a lease source, not a physical executor. Keep opaque driver requests private to the adapter, for example in a `WeakMap<StatementBindingDescription, OpaqueRequest>`.

Prepared shape identity is logical: result kind, canonical segments, dialect, ordered hints, directions, output names, and relevant procedure metadata. `$1`, `?`, `:1`, and `@p1` are transport details. A prepared execution renders once, validates that shape, describes the binding, then executes that statement.

`preparedName`, when present in `StatementBindingContext`, is a SQLBraid
logical name scoped to the live `Database` handle that created the prepared
query. It is not a globally reserved name and it is not a promise that the
same string is used as a server/driver prepared-statement name. An adapter
that maps names to native statements must derive a collision-safe native
identity from its own scope/handle state (or use unnamed/driver-owned reuse);
different live SQLBraid prepared handles that repeat a logical name must not
alias one another, and different logical shapes must not reuse one native
statement accidentally. Keep that identity private and preserve the logical
name's application meaning.

The supported SPI implementer boundary is the executor/provider/lease/binding
and documented observer contracts above. Existing required members remain
source-compatible across 1.x. Add new driver capability through optional
members/capabilities or a separate extension interface, not a new required
method for one adapter. Preserve `(statement, binding?, options?)`, trailing
options, immutable provider/lease binding identity, explicit unsupported
errors, and cleanup ownership.

## 3. Executor contract and options

Every executor method uses the same trailing options convention:

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
  begin?(options?: TransactionOptions): Awaitable<void>;
  commit?(): Awaitable<void>;
  rollback?(): Awaitable<void>;
  savepoint?(name: string): Awaitable<void>;
  rollbackTo?(name: string): Awaitable<void>;
  releaseSavepoint?(name: string): Awaitable<void>;
}
```

`ExecutionOptions` contains `signal?: AbortSignal`; row validation options add
`schema`, and stream options add the same schema plus signal. An already-aborted
signal must reject with its `reason`. An active signal requires a real adapter
cancellation path. If the adapter cannot cancel an in-flight statement, reject
before I/O with `UnsupportedFeatureError` and `BRAID_CANCEL_UNSUPPORTED`; do
not merely stop yielding while the driver continues.

## 4. Routine and bulk results

`call()` returns materialized, normalized data. It must consume and close cursors, result sets, requests, LOBs, and protocol carrier resources before lease release:

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

A cursor OUT belongs in `resultSets`, not scalar `output`. Do not expose native cursors, portals, requests, packets, or mutable driver rows.

`db.bulk(inputs, factory)` is command-only and homogeneous. The runtime renders every item, locks the first logical shape, validates the complete value matrix and binding description before acquiring a lease, then calls the optional `bulk` method once on one lease. Empty input performs no acquire. Root bulk is not implicitly transactional and does not auto-chunk. Report the actual execution mode (`native-bulk`, `pipeline`, `prepared-loop`, or `remote-batch`); never claim atomicity from a mode name.

## 5. Complete text-positional example

This adapter intentionally supports materialized queries only. It rejects active cancellation before I/O and explicitly rejects stream/call instead of buffering or guessing.

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

const requests = new WeakMap<StatementBindingDescription, {
  readonly statement: RenderedStatement;
  readonly sql: string;
  readonly values: readonly unknown[];
}>();

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
      const description = binding ?? acmeStatementBinding.describe(statement, {
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

The example has no hidden fallback: `query` is the only implemented operation,
`stream` and `call` return stable unsupported errors, and an active `AbortSignal`
is rejected as unsupported before `WireClient.execute`. A real adapter should
replace those stubs only after implementing and testing the corresponding
protocol cleanup and cancellation semantics.

## 6. Transaction and environment capabilities

Implement `begin(options)` only for options the physical connection can honor.
The portable isolation strings are `read-uncommitted`, `read-committed`,
`repeatable-read`, and `serializable`; `readOnly` is separate. Unsupported
options must throw `UnsupportedFeatureError` with a `BRAID_*` code (the runtime
uses `BRAID_TX_OPTION_UNSUPPORTED`). Nested explicit transaction options are
rejected; do not reacquire for `tx` inside a session.

Environment capability keys are canonical and capability-driven:

```text
statement.prepare       statement.stream       statement.bulk
transaction             transaction.savepoint
routine.out             routine.result-sets    routine.out-cursor
routine.return-value
```

Do not publish obsolete aliases or infer a capability from a dialect name. Use
executable database/driver/runtime/profile evidence for support labels. A Bun
adapter may support several user-selected dialects without auto-detecting one;
Deno can use an existing adapter where its public driver API works. Neither
statement creates a new dialect or promotes an unverified tuple.

## 7. SQLite driver notes

SQLite remains one dialect with driver-specific transports. The synchronous
`node:sqlite` and `better-sqlite3` adapters return plain values from physical
query, bulk, and transaction-control methods; their public databases remain
async. `better-sqlite3` uses statement-local `safeIntegers(true)`, native
`iterate()` for streams, and a prepared loop for bulk. Those calls still block
the JavaScript event loop; `Awaitable` does not provide background execution.

The libSQL adapter requires an explicit `{ intMode: "string" }` assertion before
constructing the database. It classifies results with `columns`, `rows`,
`rowsAffected`, and `lastInsertRowid`, uses `client.batch()` for bulk, and
routes an active transaction through the documented interactive Transaction
handle. Ordinary client calls do not prove a pinned session, so
`session.pinned` remains unsupported. Without a documented incremental cursor,
`statement.stream` is unsupported rather than implemented by buffering.

These are implementation facts, not broad support labels. Record the exact
driver version, runtime, profile, and transport evidence separately; local
libSQL evidence does not certify remote HTTP/WebSocket clients.
