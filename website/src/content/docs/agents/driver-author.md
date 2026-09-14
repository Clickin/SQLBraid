---
title: Driver-author binding guide
description: Implement a custom SQLBraid binding adapter without crossing the value-only security boundary.
---

This guide is for custom `QueryExecutor`, `ConnectionProvider`, and driver adapters. PV16 final verification is pending; this page does not claim a current CI result, SHA, runtime support label, or publication evidence.

## Logical statement invariant

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

`segments.length === parameters.length + 1`. Segments already include every structural decision (`@braid`, `sql.ident`, `sql.raw`, fragments, lists, joins, and trim). Every parameter is a value. A driver must not reinterpret a parameter as SQL, an identifier, a nested query, a driver fragment, or a native tagged-template command. Use `createRenderedStatement` at custom public boundaries and do not retain parallel mutable text/values/hints/maps.

## Binding adapter

```ts
interface StatementBindingAdapter {
  readonly id: string;
  describe(
    statement: RenderedStatement,
    context: StatementBindingContext,
  ): StatementBindingDescription;
}

interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: "auto" | "simple" | "reuse";
  readonly preparedName?: string;
  readonly transactionScoped?: boolean;
}
```

`StatementBindingDescription.bindings` contains immutable metadata records with
`index`, optional driver `name`, interpolation index, optional hint, direction,
and output name. It does not expose application values; keep opaque encoded
requests private.

`describe()` is pure with respect to the database. It selects one transport (`native-value-template`, `text-positional`, `text-named`, or `typed-request`), validates hints, and constructs deterministic typed request data before connection acquisition. A materialization failure is stage `"materialize"`, with both execution flags false. Driver/server/network failures remain stage `"driver"`.

The provider and every lease must expose the same adapter object:

```ts
interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}
```

Pass the same optional `StatementBindingDescription` to `query`, `call`, or `stream` so the driver does not encode twice. Keep opaque request objects private to the driver package (a `WeakMap` keyed by the description is suitable).

## Homogeneous bulk execution

PV16 `db.bulk()` is command-only: one logical DML shape is paired with an
ordered parameter matrix. It is not `db.batch()`, which accepts heterogeneous
queries.

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

Use core's `createBulkBindingDescription` for shared immutable metadata and lazy
per-item diagnostics. Drivers must encode and validate the entire matrix before
acquiring a lease. Dynamic shape/cardinality changes and `OUT`/`INOUT`
directions fail before I/O (`BRAID_BULK_SHAPE` or a materialization diagnostic).
An executor without `bulk` fails with `BRAID_BULK_UNSUPPORTED`; do not silently
loop through ordinary query calls.

Bulk uses one physical lease and reports the actual mode. Root bulk has no
portable atomicity promise and is never implicitly transactional; use
`db.tx(async (tx) => tx.bulk(...))` when callback transaction atomicity is
required. There is no portable auto-chunking contract, and observers emit one
bulk operation rather than N ordinary query operations.

## Complete custom adapter example

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

export const acmeStatementBinding: StatementBindingAdapter = Object.freeze({
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
      placeholder: (index) => `$${index}`, // one-based
      reuse: {
        effective: "simple",
        owner: "driver",
      },
    });
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

export function createAcmeExecutor(client: WireClient): QueryExecutor {
  return {
    ownershipKey: client,
    statementBinding: acmeStatementBinding,
    async query<Row>(statement: RenderedStatement, binding?: StatementBindingDescription) {
      statement = createRenderedStatement(statement);
      const description = binding ?? acmeStatementBinding.describe(statement, {
        dialectId: statement.dialectId,
        requestedReuse: "auto",
      });
      const request = requests.get(description);
      if (request?.statement !== statement) throw new Error("BRAID_BINDING_IDENTITY");
      return client.execute<Row>(request.sql, request.values);
    },
  };
}

export function createAcmeProvider(
  acquireClient: () => Promise<WireClient>,
): ConnectionProvider {
  return {
    statementBinding: acmeStatementBinding,
    async acquire(): Promise<ConnectionLease> {
      const client = await acquireClient();
      const bound = createAcmeExecutor(client);
      let released = false;
      return {
        ...bound,
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

For a typed request, keep deterministic names (`p1`, `p2`, …), map every supported hint to a driver type, validate facets, and store encoded values privately. For a native-value-template transport, use the native value-only API; never pass a logical parameter to a polymorphic tag that could treat it as structure.

## First-party transport paths

| Path | Transport and materialization | Reuse owner |
| --- | --- | --- |
| PostgreSQL / `pg` | `text-positional`, `$1..$N` | fresh unnamed simple execution, driver |
| MySQL / `mysql2` | `text-positional`, `?` | driver reuse for every request |
| MariaDB / Connector/Node.js | `text-positional`, `?` | connector-owned reuse/batch |
| SQLite / `node:sqlite` | documented `DatabaseSync.prepare(text)` with `?` | fresh simple execution, driver |
| Oracle Thin / `node-oracledb` | `text-positional`, `:1..:N`, bind descriptors | driver cache reuse |
| SQL Server / Tedious | `typed-request`, `@p1..@pN`, `TYPES.*` and facets | fresh Request/`execSql`, simple execution, driver |

`auto`, `simple`, and `reuse` are logical requests; the adapter reports the
effective policy, which must never be inferred from the request. Prepared shape
is `resultKind` + canonical segments + ordered hint signature, never placeholder
spelling. A prepared factory renders once. Do not add a universal runtime
statement cache.

## Routine, stream, and lease boundaries

Implement `QueryExecutor.stream` as a real driver path, not an `all()` buffer.
Close, drain, or cancel the driver cursor/request/iterator before releasing or
discarding the physical lease. Implement `QueryExecutor.call` as a normalized
`{ output, resultSets, returnValue? }` result: consume every cursor/ResultSet
and keep raw driver objects out of application results. Cursor OUT values belong
in `resultSets`, not scalar `output`. PostgreSQL refcursor calls require an
existing transaction; MySQL prepared CALL OUT/INOUT and SQL Server cursor output
must fail explicitly when the driver cannot prove a safe carrier. MariaDB-specific
syntax and protocol evidence belongs to `@sqlbraid/mariadb/mariadb`; a `mysql2`
connection to MariaDB is best-effort compatibility, not Official MariaDB
evidence.

## Hints, providers, and observers

Honor every supported hint or reject it before I/O; never silently ignore one. Preserve driver-specific null, numeric, temporal, binary, facet, recordset, ResultSet, and unsupported-call behavior. Keep provider and lease binding identity equal, release materialized leases before asynchronous mapping, and retain stream leases until iteration closes.

`query:ready` exposes readonly effective `{ adapterId, dialectId, transport, reuse }` before acquisition. Values, hints, interpolation map, result kind, fingerprints, prepared name, and transaction context remain derived readonly views. `literalizedSql(options?)` is lazy/cached, redacted by default, and diagnostic-only. It reconstructs `segment[0] + literal(parameter[0]) + ...` directly from logical arrays; it never replaces placeholders and must never be sent to the database. Support max length, binary summary/full mode, custom redaction, and complete/redacted/truncated accounting. Unsupported objects receive a safe marker, not accidental `toString()` output.

## Native-value security conformance

Include this negative fixture in the reusable adapter suite:

```ts
const nativeFragment = { kind: "native-sql-fragment", text: "DROP TABLE accounts" };
const statement = render(sql`SELECT ${nativeFragment}`);
const description = acmeStatementBinding.describe(statement, {
  dialectId: "acme-sql",
  requestedReuse: "auto",
});

// One value parameter remains; no fragment text enters statement segments.
// Materialization sends nativeFragment as a value or rejects it.
```

Also describe one adapter object under multiple dialect contexts. Context may alter driver policy or diagnostic literal formatting, but never the core value-only invariant. `sql.raw`, `sql.ident`, and explicit fragment helpers are the only structural paths.

For the full contract and checklist, see [`docs/driver-author-guide.md`](https://github.com/Clickin/SQLBraid/blob/main/docs/driver-author-guide.md).
