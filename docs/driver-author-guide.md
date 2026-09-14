# Driver-author guide: binding transport SPI

This guide is for a custom `QueryExecutor`, `ConnectionProvider`, or first-party-style driver adapter. PV16 final verification is pending; this guide does not grant a runtime/driver support label or claim current CI, SHA, publication, or release evidence.

## 1. The logical statement contract

The template/core renderer is the only owner of SQLBraid structure. It returns one immutable `RenderedStatement`:

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
  readonly resultKind: QueryResultKind;
  readonly dialectId: string;
  readonly routineProcedure?: {
    readonly name: string;
    readonly parameterNames: readonly string[];
  };
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}
```

The invariant is:

```text
segments.length === parameters.length + 1
```

`segments` already contains every structural decision: Braid directives, `sql.ident`, `sql.raw`, fragments, list/join expansion, and trim handling. A `RenderedParameter` is always a value. It is never raw SQL, an identifier, a nested query, a driver fragment, or a tagged-template command. A native driver object with polymorphic interpolation semantics must stay a value or be rejected when passed as ordinary `${value}`.

Use `createRenderedStatement` when constructing or receiving a statement at a public boundary. Do not retain mutable parallel `text`, `values`, `parameterHints`, or binding-map arrays as another execution source of truth. Derived observer views may be built from `parameters`.

## 2. Binding adapter contract

The driver owns physical materialization. Core exports these contracts:

```ts
type ParameterTransportKind =
  | "native-value-template"
  | "text-positional"
  | "text-named"
  | "typed-request";

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
}

interface StatementBindingDescription {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly parameterizedSql?: string;
  readonly bindings: readonly BindingDescription[];
  readonly reuse: {
    readonly requested: "auto" | "simple" | "reuse";
    readonly effective: "simple" | "reuse";
    readonly owner: "sqlbraid" | "driver" | "server";
    readonly capacity?: number;
  };
  literalizedSql(options?: LiteralizeOptions): LiteralizedSqlResult;
}

interface BindingDescription {
  readonly index: number;
  readonly name?: string;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
  readonly direction?: "in" | "out" | "inout";
  readonly outputName?: string;
}
```

`describe` is pure with respect to the database: it does not acquire a connection, prepare a server statement, execute SQL, or mutate a pool. Validate every hint and construct any deterministic typed request before acquisition. A failure in this work is a `materialize` error with `executionStarted === false` and `executionCompleted === false`; driver, server, and network failures remain `driver` errors.

The exact same adapter object must be exposed by a provider and its leases:

```ts
interface QueryExecutor {
  readonly statementBinding: StatementBindingAdapter;
  query(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
  ): Promise<QueryExecutionResult>;
  stream(
    statement: RenderedStatement,
    signal?: AbortSignal,
    binding?: StatementBindingDescription,
  ): AsyncIterable<unknown>;
  call(
    statement: RenderedStatement,
    binding?: StatementBindingDescription,
  ): Promise<DriverRoutineResult>;
}

interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
```

A lease must not silently use a different binding adapter. Keep opaque driver requests in the driver package; a `WeakMap<StatementBindingDescription, OpaqueRequest>` is an appropriate private association when the executor needs already-encoded data.

### Homogeneous bulk execution

PV16 `db.bulk()` is command-only and represents one logical DML shape with an
ordered matrix of values. It is distinct from `db.batch()`, which executes
heterogeneous queries.

```ts
interface RenderedBulk {
  readonly statement: RenderedStatement;
  readonly parameterSets: readonly (readonly unknown[])[];
}

interface BulkBindingDescription {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly itemCount: number;
  readonly valuesAt(index: number): readonly unknown[];
  readonly literalizedSql(
    index: number,
    options?: LiteralizeOptions,
  ): LiteralizedSqlResult;
  readonly parameterizedSql?: string;
  readonly bindings: readonly BindingDescription[];
}

interface StatementBindingAdapter {
  // describe(...) remains required for ordinary statements.
  readonly describeBulk?: (
    bulk: RenderedBulk,
    context: StatementBindingContext,
  ) => BulkBindingDescription;
}

interface BulkExecutionResult {
  readonly inputCount: number;
  readonly affectedRows?: number;
  readonly executionMode:
    | "native-bulk"
    | "pipeline"
    | "prepared-loop"
    | "remote-batch";
}

interface QueryExecutor {
  readonly bulk?: (
    bulk: RenderedBulk,
    binding: BulkBindingDescription,
  ) => Promise<BulkExecutionResult>;
}
```

Use core's `createBulkBindingDescription` so all items share one immutable
metadata set while per-item diagnostics remain lazy. Drivers must encode and
validate the complete matrix before acquiring a lease. Shape, list/cardinality,
hint, and `OUT`/`INOUT` direction mismatches fail before database I/O
(`BRAID_BULK_SHAPE` or the specific materialization diagnostic). A custom
executor without `bulk` fails with `BRAID_BULK_UNSUPPORTED`; do not silently
loop through ordinary query calls.

Bulk uses one physical lease and reports its actual execution mode. Root bulk
has no portable atomicity promise and is never implicitly wrapped in a
transaction; use `db.tx(async (tx) => tx.bulk(...))` when callback transaction
atomicity is required. There is no portable auto-chunking contract. Bulk
observers emit one bulk lifecycle operation, not N ordinary query operations.

`call()` returns a raw normalized routine result, not application generic types:

```ts
interface DriverRoutineResult {
  readonly output: Readonly<Record<string, unknown>>;
  readonly returnValue?: unknown;
  readonly resultSets: readonly {
    readonly rows: readonly unknown[];
    readonly source:
      | { readonly kind: "out-cursor"; readonly name?: string; readonly parameterIndex?: number }
      | { readonly kind: "implicit"; readonly index: number }
      | { readonly kind: "emitted"; readonly index: number };
  }[];
}
```

Never return an Oracle `ResultSet`, PostgreSQL portal, MySQL command packet, or
Tedious `Request` in this value. Consume and close driver resources first; the
runtime maps the materialized rows to the query's heterogeneous
`RoutineCallResult` contract after lease release. A cursor OUT value belongs in
`resultSets`, not scalar `output`.

## 3. Complete custom text-positional adapter

The following is a complete shape for a small driver that uses one text statement and one value array. The wire client is intentionally driver-owned and opaque to core.

```ts
import {
  createRenderedStatement,
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
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

function customPlaceholder(index: number): string {
  return `$${index}`; // one-based indexes are required
}

export const customStatementBinding: StatementBindingAdapter = Object.freeze({
  id: "acme-wire",

  describe(statement: RenderedStatement, context: StatementBindingContext) {
    statement = createRenderedStatement(statement);
    for (const parameter of statement.parameters) {
      if (parameter.hint !== undefined) {
        throw new Error("BRAID_BIND_HINT_UNSUPPORTED");
      }
    }

    const description = createStatementBindingDescription(statement, context, {
      adapterId: "acme-wire",
      transport: "text-positional",
      placeholder: customPlaceholder,
      reuse: {
        effective: "simple",
        owner: "driver",
      },
    });

    // The helper's parameterizedSql is derived from segments. Values are kept
    // in the private association, never copied into the public description.
    const text = description.parameterizedSql;
    if (text === undefined) throw new Error("BRAID_BIND_TRANSPORT");
    requests.set(description, {
      statement,
      sql: text,
      values: statement.parameters.map((parameter) => parameter.value),
    });
    return description;
  },
});

export function createCustomExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: customStatementBinding,

    async query<Row>(
      statement: RenderedStatement,
      binding?: StatementBindingDescription,
    ) {
      statement = createRenderedStatement(statement);
      const description = binding ?? customStatementBinding.describe(statement, {
        dialectId: statement.dialectId,
        requestedReuse: "auto",
      });
      const request = requests.get(description);
      if (request?.statement !== statement) {
        // A description from another adapter or statement is not compatible.
        throw new Error("BRAID_BINDING_IDENTITY");
      }
      return client.execute<Row>(request.sql, request.values);
    },
  };
}

export function createCustomProvider(
  acquireClient: () => Promise<WireClient>,
): ConnectionProvider {
  return {
    statementBinding: customStatementBinding,

    async acquire(): Promise<ConnectionLease> {
      const client = await acquireClient();
      const executor = createCustomExecutor(client);
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

For a typed request, replace the `parameterizedSql`/value-array construction with a private request containing deterministic names (`p1`, `p2`, …), mapped driver types, encoded values, and facets. For a native-value-template transport, do not pass the logical statement to a polymorphic native tag; call the native value-only API or reject values it cannot represent safely.

## 4. Transport and reuse policy

Transport is a driver fact, not a dialect fact. The first-party paths are documented as follows:

| Database path | Transport | Placeholder/request ownership | Reuse policy |
| --- | --- | --- | --- |
| PostgreSQL / `pg` | `text-positional` | adapter emits `$1..$N` | fresh unnamed simple execution, driver-owned |
| MySQL / `mysql2` | `text-positional` | adapter emits `?` | driver-owned reuse for every request |
| MariaDB / Connector/Node.js | `text-positional` | adapter emits `?` | connector-owned reuse/batch |
| SQLite / `node:sqlite` | `text-positional` | adapter prepares documented `?` SQL | fresh simple execution, driver-owned |
| Oracle Thin / `node-oracledb` | `text-positional` | adapter emits `:1..:N` and bind descriptors | driver cache reuse, driver-owned |
| SQL Server / Tedious | `typed-request` | adapter emits `@p1..@pN` and `TYPES.*` facets | fresh Request/`execSql`, simple execution, driver-owned |

`requestedReuse` is logical policy (`auto`, `simple`, or `reuse`). The adapter
reports the effective policy and its owner; never infer effect from the request.
Do not add a universal runtime prepared-statement cache merely to normalize this
metadata. Prepared shape identity uses result kind, canonical segments, and
ordered hint signatures; it does not use physical placeholder syntax.

SQLite adapters must use the documented `DatabaseSync.prepare(text)` and `StatementSync` path. Do not invoke `SQLTagStore` as though its tagged-template function were a normal callable unless a supported API path preserves SQLBraid result checks and duplicate-column handling.

## 5. Hints: honor or reject

A hint selects database parameter metadata; it is not application validation or an input codec. An adapter must either map every supported hint to its driver descriptor or reject unsupported hints before I/O with `BRAID_BIND_HINT_UNSUPPORTED` (or a more specific materialization diagnostic). Never silently discard a hint. Keep hint structure in prepared shape identity; parameter values do not participate.

MariaDB-specific syntax and protocol evidence belongs to the official MariaDB
Connector/Node.js adapter. A `mysql2` connection to MariaDB remains best-effort
compatibility and must not receive an Official MariaDB label.

Oracle must preserve its null, NUMBER, temporal, LOB, explicit/implicit ResultSet
policies and close every live ResultSet before lease release. Tedious must
preserve type inference, precision/scale/length validation, exactness checks,
multiple recordsets, and explicit procedure metadata for native RETURN status.
Unsupported MySQL OUT/INOUT carrier detection, SQL Server cursor outputs,
SQLite routine calls, and any return-value capability must remain explicit; do
not guess a carrier or simulate a cursor.

## 6. Observer and diagnostic description

The `query:ready` event is emitted from the immutable description before physical I/O. Its readonly execution projection contains:

```ts
execution: {
  adapterId: string;
  dialectId: string;
  transport: ParameterTransportKind;
  reuse: {
    requested: "auto" | "simple" | "reuse";
    effective: "simple" | "reuse";
    owner: "sqlbraid" | "driver" | "server";
    capacity?: number;
  };
}
```

Raw parameter values, hints, interpolation metadata, result kind, fingerprints, prepared name, and transaction context remain available as derived readonly views. SQLBraid does not log values automatically; examples and audit handlers should redact by default.

The parameterized SQL view may be absent for a `native-value-template` transport.

`literalizedSql(options?)` is a lazy, cached diagnostic reconstruction. It concatenates each logical segment with the formatted value at that boundary:

```text
segment[0] + literal(parameter[0]) + segment[1] + ... + segment[N]
```

It never replaces `$1`, `?`, `:1`, or `@p1` in already-materialized SQL and never reparses SQL. It may differ from protocol text and must never be used as execution input. Support redacted/inline values, maximum value length, binary summary/full mode, a custom redactor, and result accounting (`complete`, `redactedParameters`, `truncatedParameters`). Format null, strings, booleans, finite numbers, bigint, honest date/temporal forms, and binary values deterministically. Unsupported custom objects get a safe marker rather than accidental `toString()` execution.

## 7. Native-value security conformance

Run the reusable transport conformance suite for every adapter. At minimum, assert that a native structural/query fragment object passed as ordinary data never becomes SQL structure:

```ts
const nativeFragment = {
  // A native tag might normally treat this as a structural fragment.
  kind: "native-sql-fragment",
  text: "DROP TABLE accounts",
};

const statement = render(sql`SELECT ${nativeFragment}`);
const binding = customStatementBinding.describe(statement, {
  dialectId: "acme-sql",
  requestedReuse: "auto",
});

// Required observations:
// 1. statement.parameters has one value record containing nativeFragment.
// 2. segments has the same structural SELECT text and one boundary.
// 3. materialization sends nativeFragment as a value or rejects it.
// 4. no executable fragment text is introduced.
```

Also prove that one adapter object describes statements under multiple dialect contexts. The context may change quoting, literal diagnostics, or driver policy, but it must not change the core value-only invariant. `sql.raw`, `sql.ident`, and explicit fragment APIs are the only structural paths.

## 8. Provider and lease checklist

Before accepting an adapter:

- expose a stable named `statementBinding` object;
- make provider and every lease share that exact object identity;
- compute and validate binding descriptions before `acquire()`;
- pass the same description to execution to avoid duplicate encoding;
- keep opaque driver request types out of core types;
- release materialized leases before asynchronous row mapping;
- retain a stream lease until iteration closes;
- close/drain/cancel the driver stream before releasing or discarding that lease;
- consume and close every routine cursor/request before mapping or releasing;
- report materialization failures separately from driver I/O;
- preserve transaction pinning and result-kind checks;
- document unsupported capabilities instead of simulating them.

PV16 completion and release readiness require exact-revision verification across
unit, packed-runtime, docs, capability/bulk suites, Browser WASM, D1, MariaDB,
and the existing real database paths. Until Main supplies that evidence, mark
verification pending and do not claim a new SHA, CI success, runtime support
label, or publication.
