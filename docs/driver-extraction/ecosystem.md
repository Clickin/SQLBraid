# Driver extraction: ecosystem research

## Scope and conclusion

Research date: 2026-10-20. This report compares execution interfaces, not SQL syntax portability.
It does not establish SQLBraid compatibility with another library.
No upstream changes, database checks, or performance checks form part of this research.

**Recommendation:** use Kysely as the first external integration experiment.
Its public dialect interface separates SQL compilation from connection execution.
Do not copy JDBC's complete API or treat ORM sessions as a neutral execution interface.

Kysely signatures below use published version **0.29.7**.
The repository already declares that version in [`tests/package.json`](../../tests/package.json).
Drizzle examples use source tag **0.45.3**, and Prisma uses **7.3.0**.
These versions describe the inspected interfaces, not every supported version.
Other branch links describe the sources read on the research date; they can change.

## Comparison

### JDBC

- **Standard surface:** `Connection`, `Statement`, `PreparedStatement`, `ResultSet`, and `DatabaseMetaData` define execution and inspection interfaces.
- **Driver specifics:** drivers implement protocol access, SQL type conversion, optional features, and database metadata. JDBC does not make SQL dialects identical.
- **Ownership:** the application obtains a connection and closes it. A pool can manage the physical connection behind that interface.
  A connection owns transaction state through auto-commit, commit, rollback, isolation, and savepoint operations.
- **Types and values:** prepared statements provide typed setters and `setObject`. Results provide typed getters, SQL metadata, and custom type mapping.
- **Streaming:** `ResultSet.next()` provides cursor traversal. Fetch size is a driver hint, not a promise of bounded network buffering.
  Result-set type, concurrency, and holdability remain explicit concerns.
- **Capabilities:** `DatabaseMetaData` reports driver-and-database capabilities, including transactions, savepoints, batching, and result-set support.
- **Independent generator adoption:** jOOQ accepts JDBC connections or data sources while retaining its own SQL generation.
  This is observed cross-project reuse, not an inference from matching method names.

Sources: [Connection][jdbc-connection], [PreparedStatement][jdbc-prepared],
[ResultSet][jdbc-results], [DatabaseMetaData][jdbc-metadata], [jOOQ configuration][jooq].

**Constraint:** copy explicit ownership and feature reporting, not the complete JDBC object model.
Java SQL types and synchronous cursor APIs do not define JavaScript value or cancellation behavior.

### Knex clients and dialects

- **Standard surface:** the shared `Client` creates builders, compilers, runners, transactions, and pool operations.
  It delegates query and stream work to dialect implementations.
- **Driver specifics:** PostgreSQL replaces bind markers, calls `pg`, creates streams, and interprets native results.
  Its `processResponse` branches on Knex query methods such as `raw`, `first`, and `pluck`.
- **Ownership:** `Client` acquires and releases connections. A transaction creates a client that reuses one connection.
  The transaction wrapper rejects execution on another connection. It does not release an externally supplied connection.
- **Types and values:** SQL and bindings reach the native driver. Result shaping depends on Knex query metadata, not SQL alone.
- **Streaming:** the PostgreSQL client uses `pg-query-stream`. The inspected implementation reports a missing dependency when streaming is unavailable.
- **Capabilities:** behavior lives across clients, dialect compilers, and transaction implementations.
  The inspected base client does not define one comprehensive execution capability record.
- **Independent generator adoption:** the execution path can receive raw SQL, but its client interface also serves Knex compilation and result shaping.
  The inspected sources do not establish another SQL generator's adoption of this client interface.

Sources: [base client][knex-client], [PostgreSQL client][knex-pg], [transaction lifecycle][knex-tx].

**Constraint:** avoid importing query-builder method names into the neutral result format.
A raw driver result and a builder's `first()` result are different layers.

### Kysely Driver and DatabaseConnection

- **Standard surface:** `Dialect` creates a driver, compiler, adapter, and introspector separately.
  `Driver` manages connections and transaction operations. `DatabaseConnection` executes compiled queries and streams result chunks.
- **Driver specifics:** the PostgreSQL implementation calls `pg`, maps command counts, and uses an optional cursor implementation.
- **Ownership:** the driver acquires and releases a connection. Transaction methods receive that same connection explicitly.
  The executor retains the connection during streaming and coordinates iterator cleanup.
- **Types and values:** `CompiledQuery` contains SQL, readonly `unknown` parameters, an operation node, and a query identifier.
  `QueryResult` contains rows and optional `bigint` command metadata. It has no column-type or bind-hint fields.
- **Streaming:** `streamQuery` returns chunks through `AsyncIterableIterator<QueryResult<R>>`.
  PostgreSQL requires cursor configuration; the presence of the method does not guarantee streaming support.
- **Capabilities:** `DialectAdapter` has specific flags, including returning and transactional DDL support.
  These are dialect features, not a full declaration of transport, decoding, or cancellation guarantees.
- **Independent generator adoption:** a custom dialect can supply an external driver without replacing Kysely's compiler.
  This is a documented extension point. It does not prove that another project wants SQLBraid's implementation.

Sources: [Driver 0.29.7][kysely-driver], [DatabaseConnection 0.29.7][kysely-connection],
[CompiledQuery 0.29.7][kysely-query], [Dialect 0.29.7][kysely-dialect],
[PostgreSQL implementation][kysely-pg], [executor lifecycle][kysely-executor],
[dialect capability interface][kysely-capabilities].

### Drizzle sessions

- **Standard surface:** PostgreSQL defines `PgSession`, `PgPreparedQuery`, and `PgTransaction`.
  Session preparation accepts selected fields, result mapping, and query metadata alongside SQL and parameters.
- **Driver specifics:** `NodePgSession` uses `pg` clients and pools. Prepared queries select object or array rows and override selected native type parsers.
- **Ownership:** the node-postgres transaction path acquires a pool client, creates a transaction session, and releases the client in `finally`.
  Nested transactions use savepoints on the session.
- **Types and values:** session code fills placeholders and maps positional results through Drizzle fields or a custom mapper.
  That mapping includes schema-level behavior, rather than only native driver conversion.
- **Streaming:** the inspected MySQL2 session implements an async iterator using the native stream.
  The inspected node-postgres session does not expose an equivalent cursor method. Do not generalize MySQL2 support to every session.
- **Capabilities:** the inspected sessions have different methods and generic result types.
  They do not expose one common record that proves all execution features across drivers.
- **Independent generator adoption:** these sessions import Drizzle dialect, schema, SQL, and mapping types.
  The inspected sources do not establish another SQL generator's use of the session abstraction.

Sources: [PostgreSQL session interface][drizzle-session], [node-postgres session][drizzle-pg],
[MySQL2 iterator][drizzle-mysql].

**Constraint:** keep schema decoding above the driver boundary.
A bridge must not apply both the native wrapper's conversion and Drizzle's field decoder to the same value without a defined policy.

### Prisma driver adapters

- **Standard surface:** `SqlDriverAdapterFactory.connect()` creates an adapter.
  `SqlQueryable` exposes `queryRaw` and `executeRaw`. The adapter adds scripts, transactions, optional connection information, and disposal.
- **Driver specifics:** implementations supply provider identity, native value conversion, error mapping, and transaction resources.
  The interface defines database-specific error variants as well as shared categories.
- **Ownership:** `startTransaction()` returns a queryable transaction with commit and rollback methods.
  The interface exposes disposal, not a general public acquire/release pair for arbitrary sessions.
- **Types and values:** `SqlQuery` carries SQL, arguments, and argument types.
  `SqlResultSet` carries column names, column types, positional rows, and an optional textual insert identifier.
  Object rows alone cannot preserve duplicate column names or all required metadata.
- **Streaming:** the inspected 7.3.0 interface has no streaming method. `queryRaw` returns a materialized result set.
- **Capabilities:** provider identity and optional connection information describe selected properties.
  `ConnectionInfo` includes `maxBindValues`, `schemaName`, and `supportsRelationJoins`.
  These do not form a complete general-purpose capability model.
- **Independent generator adoption:** the types explicitly describe conversion into Prisma's query-engine values.
  They provide an execution seam for Prisma, not evidence of a shared standard adopted by independent generators.

Source: [Prisma adapter types, version 7.3.0][prisma-types].

**Constraint:** do not claim Prisma compatibility from `query(sql, params)` alone.
A real bridge needs argument typing, positional result metadata, transaction behavior, and error conversion.

### database-js

This section covers **mlaanderson/database-js**, not PlanetScale's project with the same repository name.

- **Standard surface:** a connection string selects a wrapper. `Connection.prepareStatement()` returns a statement with `query` and `execute`.
- **Driver specifics:** the driver guide asks wrappers to implement SQL execution, closing, and optional transaction methods.
- **Ownership:** `Connection.close()` closes the underlying connection. Transaction state and begin/commit/rollback operations belong to that wrapper.
  Pool policy is not part of the README's basic interface.
- **Types and values:** statement arguments and results use broad JavaScript types.
  The README describes prepared statements even when the underlying driver lacks native support.
  The driver guide shows `query(sql)` and `execute(sql)`, rather than a required separate parameter array.
- **Streaming:** the basic API returns an array of rows. The inspected interface does not define a stream lifecycle.
- **Capabilities:** `isTransactionSupported()` and `inTransaction()` expose transaction support and state.
  The inspected API does not define a broader capability record.
- **Independent generator adoption:** wrappers for several databases demonstrate implementation reuse.
  The README links a CodeceptJS helper, but that is not evidence of independent SQL-generator adoption.

Sources: [README and basic API][databasejs], [driver implementation guide][databasejs-drivers].

**Constraint:** distinguish native bind parameters from emulated statement preparation.
This interface alone does not establish SQLBraid-equivalent binding, precision, or cleanup behavior.

### DB0: another neutral JavaScript execution abstraction

- **Standard surface:** `Connector` exposes `exec`, `prepare`, `getInstance`, and optional disposal.
  `Database` adds a tagged SQL method and explicit disposal. Statements expose `bind`, `all`, `get`, and `run`.
- **Driver specifics:** a connector names its dialect and native instance. It can override database capabilities.
- **Ownership:** the connector owns native resource access and optional disposal.
  The inspected interface has no explicit connection lease or transaction-scope method.
- **Types and values:** `Primitive` includes string, number, boolean, undefined, and null.
  It does not include bigint, bytes, dates, or arrays, despite separate capability flags for some database features.
  `all()` returns unknown rows; `run()` promises a success flag, not a standardized exact command count.
- **Streaming:** the inspected interface has no stream operation.
- **Capabilities:** explicit booleans cover JSON, booleans, arrays, dates, UUIDs, and transactions.
  A transaction capability flag does not supply connection pinning or transaction lifecycle operations.
- **Independent generator adoption:** the interface accepts caller-supplied SQL and does not require an ORM schema or AST.
  The inspected sources do not establish an independent generator's adoption. The README labels development as early-stage.

Sources: [DB0 interfaces][db0-types], [DB0 README][db0-readme].

**Constraint:** a small interface is useful only when its omitted behaviors match the consumer's requirements.
Do not remove exact values or session ownership merely to match a smaller API.

## Concrete Kysely adapter boundary

These excerpts preserve the required method signatures from Kysely 0.29.7.
Imports, documentation comments, and optional control/savepoint methods are omitted here, not from the upstream interface.

<!-- doc-snippet: skip -->

```ts
interface Driver {
  init(options?: AbortableOperationOptions): Promise<void>;
  acquireConnection(options?: AbortableOperationOptions): Promise<DatabaseConnection>;
  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void>;
  commitTransaction(connection: DatabaseConnection): Promise<void>;
  rollbackTransaction(connection: DatabaseConnection): Promise<void>;
  releaseConnection(connection: DatabaseConnection, options?: AbortableOperationOptions): Promise<void>;
  destroy(options?: AbortableOperationOptions): Promise<void>;
}

interface DatabaseConnection {
  executeQuery<R>(compiledQuery: CompiledQuery, options?: AbortableOperationOptions): Promise<QueryResult<R>>;
  streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: AbortableOperationOptions,
  ): AsyncIterableIterator<QueryResult<R>>;
}

interface QueryResult<R> {
  readonly numAffectedRows?: bigint;
  readonly numChangedRows?: bigint;
  readonly insertId?: bigint;
  readonly rows: R[];
}
```

`TransactionSettings` permits access mode and isolation level.
Optional driver methods implement savepoint creation, rollback, and release.
Each receives the connection, savepoint name, and Kysely's `compileQuery` function.
Optional connection methods include `collectSessionInfo`, `cancelQuery`, and `killSession`.
Sources: [Driver][kysely-driver] and [DatabaseConnection][kysely-connection].

### Feasible integration without upstream changes

**[INFERENCE]** An external package can implement these interfaces and provide a custom `Dialect`.
Its `createDriver()` can return the bridge while other methods retain the appropriate Kysely dialect implementations.
The public [Dialect interface][kysely-dialect] explicitly permits custom implementations.
This establishes an extension route, not a tested compatibility claim.

| Crossing       | Required adapter behavior                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Compilation    | Keep Kysely's compiler and placeholder dialect. Pass its SQL and parameters unchanged to the execution layer.                          |
| Connection     | Wrap one acquired execution lease as one Kysely connection. Do not acquire a different connection for each operation.                  |
| Transactions   | Begin, commit, and rollback on that same lease. Preserve isolation and access mode, or reject unsupported settings.                    |
| Values         | Preserve the chosen native representation. Do not treat `R` as runtime validation or infer bind types from a TypeScript generic.       |
| Results        | Return rows plus available command metadata. Do not infer affected rows from the number of returned rows.                              |
| Exact integers | Convert counts or insert identifiers to `bigint` only when their source representation is exact. Preserve absence.                     |
| Streaming      | Emit bounded chunks from a real stream. Forward early iterator termination and close the cursor before releasing the lease.            |
| Cancellation   | Define what each abort and optional control method does. Do not claim database cancellation from rejecting a JavaScript promise.       |
| Shutdown       | State whether the bridge owns its pool. Do not destroy a caller-owned shared pool without an explicit ownership rule.                  |
| Capabilities   | Keep SQL dialect flags separate from transport and session capabilities. Reject unavailable operations rather than emulate guarantees. |

A prototype must test transaction pinning, rollback, early stream termination, and command metadata before claiming those behaviors.
It must also cover the exact Kysely version it targets.
This research performs none of those checks.

The existing benchmark constructs Kysely with its normal PostgreSQL dialect and a shared native pool.
That is evidence of existing local usage, not evidence of an extracted-driver bridge.
See [`tests/performance/postgres.mjs`](../../tests/performance/postgres.mjs).

## Demand limits and decision criteria

Repeated acquisition, execution, and release code shows repeated work.
It does not identify a consumer willing to accept a shared dependency, release schedule, value model, or lifecycle rules.
A wrapper can contain similar calls while assigning different meanings to the same result.
Knex query-method shaping, Drizzle field decoding, and Prisma positional metadata demonstrate those differences.

This research establishes these limits:

- JDBC has a documented independent SQL-generator consumer: jOOQ.
- Kysely exposes a suitable public extension point for an experiment.
- database-js and DB0 show that neutral JavaScript wrappers already exist.
- The inspected sources do not demonstrate demand for a new SQLBraid-derived package.
- No maintainer commitment, migration request, or cross-project compatibility check is established here.
- No performance benefit follows from extracting duplicate code. A bridge can add allocations, conversion, and asynchronous boundaries.

Before promoting the experiment, require a named external consumer and a concrete integration problem.
Require agreement on connection ownership, supported values, transaction scope, and failure cleanup.
Measure the bridge against the same native driver and the consumer's existing adapter.
Keep SQLBraid's stable implementation unchanged until those results justify a migration.

## Source index

[jdbc-connection]: https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/Connection.html
[jdbc-prepared]: https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/PreparedStatement.html
[jdbc-results]: https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/ResultSet.html
[jdbc-metadata]: https://docs.oracle.com/en/java/javase/21/docs/api/java.sql/java/sql/DatabaseMetaData.html
[jooq]: https://www.jooq.org/doc/dev/manual/sql-building/dsl-context/
[knex-client]: https://github.com/knex/knex/blob/master/lib/client.js
[knex-pg]: https://github.com/knex/knex/blob/master/lib/dialects/postgres/index.js
[knex-tx]: https://github.com/knex/knex/blob/master/lib/execution/transaction.js
[kysely-driver]: https://unpkg.com/kysely@0.29.7/dist/driver/driver.d.ts
[kysely-connection]: https://unpkg.com/kysely@0.29.7/dist/driver/database-connection.d.ts
[kysely-query]: https://unpkg.com/kysely@0.29.7/dist/query-compiler/compiled-query.d.ts
[kysely-dialect]: https://unpkg.com/kysely@0.29.7/dist/dialect/dialect.d.ts
[kysely-pg]: https://github.com/kysely-org/kysely/blob/master/src/dialect/postgres/postgres-driver.ts
[kysely-executor]: https://github.com/kysely-org/kysely/blob/master/src/query-executor/query-executor-base.ts
[kysely-capabilities]: https://github.com/kysely-org/kysely/blob/master/src/dialect/dialect-adapter.ts
[drizzle-session]: https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-orm/src/pg-core/session.ts
[drizzle-pg]: https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-orm/src/node-postgres/session.ts
[drizzle-mysql]: https://github.com/drizzle-team/drizzle-orm/blob/0.45.3/drizzle-orm/src/mysql2/session.ts
[prisma-types]: https://github.com/prisma/prisma/blob/7.3.0/packages/driver-adapter-utils/src/types.ts
[databasejs]: https://github.com/mlaanderson/database-js/blob/master/README.md
[databasejs-drivers]: https://github.com/mlaanderson/database-js/wiki/Drivers#implementing-a-new-driver
[db0-types]: https://github.com/unjs/db0/blob/main/src/types.ts
[db0-readme]: https://github.com/unjs/db0/blob/main/README.md
