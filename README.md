# SQLBraid

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It keeps ordinary SQL as the primary authoring language while adding safe binds, readable dynamic SQL, explicit result contracts, Standard Schema result mapping, transaction-safe execution and first-party PostgreSQL/MySQL/MariaDB/SQLite/Oracle/SQL Server integrations, with SQLite WASM and D1 adapter paths.

```ts
interface UserRow {
  id: string;
  name: string;
}

const users = sql.rows<UserRow>`
  SELECT u.id, u.name
  FROM users u
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/
`;
```

> **Status:** pre-release PV17. The value-fidelity migration is in progress on
> baseline `dccb69763e9e4a070280cf580d8f7b76368ec3d5`. Final Runtime, Docs and
> Release dry-run gates for the changed contract are pending; no current
> revision or workflow result is claimed. Historical PV16 evidence remains in
> the release records and is not PV17 evidence. RC publication still requires
> user acceptance and explicit release authorization. See [`PLAN.md`](./PLAN.md).

[Get started](https://clickin.github.io/SQLBraid/dev/getting-started/sqlite/) ·
[Documentation](https://clickin.github.io/SQLBraid/) ·
[Data representations](https://clickin.github.io/SQLBraid/dev/concepts/data-representation/) ·
[Packed executable examples](./examples/) ·
[Public API inventory](./docs/public-api-audit.md) ·
[Driver-author guide](./docs/driver-author-guide.md)

---

## Why SQLBraid?

SQLBraid sits between low-level drivers and query-builder/ORM-first libraries:

- write SQL directly;
- bind values safely;
- keep dynamic SQL next to the statement;
- declare the application row type explicitly;
- optionally validate/transform rows through Standard Schema;
- execute through a small runtime abstraction;
- keep metadata/codegen optional.

SQLBraid does not need a local function registry or complete SQL parser before you can use database-specific SQL.

```ts
const report = sql.rows<ReportRow>`
  SELECT
    custom_company_score(account_id) AS score,
    jsonb_build_object('id', account_id) AS metadata
  FROM reporting_view
`;
```

## Value fidelity

PV17 preserves database value semantics before application convenience:

```text
exact integer or decimal  → string
IEEE-754 approximate float → number
```

`TypePolicy.numeric` separates `semantics`, raw `representation`, and transport
`fidelity` (`lossless`, `guarded`, `lossy`, or `unsupported`). Exact output is
never promoted to `number` or `bigint` merely because the current value is
small. Use `decodeExactInteger` or an application-selected Decimal, Money, or
domain transform through Standard Schema when the application needs a richer
type. There is no global numeric mode.

JSON and temporal values follow the same boundary: a lossless text profile is
distinct from parsed JSON or native `Date` convenience. Driver options such as
PostgreSQL query-local parsers, mysql2 `jsonStrings`/`dateStrings`, MariaDB
`autoJsonMap`/`dateStrings`, and explicit Oracle/SQL Server text expressions
are profile evidence, not automatic rewrites. Exact driver-limited paths fail
closed or remain unsupported. `null` is SQL `NULL`; ordinary `undefined` binds
fail before connection acquisition with `BRAID_BIND_VALUE_UNSUPPORTED`.

See [data representations](https://clickin.github.io/SQLBraid/dev/concepts/data-representation/)
for the EN/KO driver matrix, JSON/temporal examples, container classification,
and user-authored SQL workarounds.

---

## Dynamic SQL

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
    /*@braid if ${teamId != null}*/
      AND team_id = ${teamId}
    /*@braid end*/
  /*@braid end*/
`;
```

Supported v1 directives are `if`, `choose`, `when`, `otherwise`, `where`, `set` and `trim`.

The compiler transform preserves lazy evaluation for guarded TypeScript expressions; inactive branches are not evaluated.

Structural SQL is explicit:

```ts
sql.ident(columnName)
sql.fragment`ORDER BY created_at DESC`
sql.list(ids)
sql.join(parts, sql.fragment`, `)
sql.raw(trustedSql)
```

Ordinary `${value}` interpolation is always a bind parameter.

When a database parameter type must be explicit, use `sql.bind(value, hint)`:

```ts
import { mssqlParameter, sql } from "@sqlbraid/mssql";

const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users
  WHERE id = ${sql.bind(id, mssqlParameter.int())}
`;
```

`${value}` uses the driver's documented inference. `${sql.bind(value, hint)}` requests an explicit database parameter type. SQLBraid does not infer a universal database type from a TypeScript type; parameter hints are not application input codecs or validation.

Template rendering produces one immutable logical statement: `segments` contain
resolved structural SQL and `parameters` contain ordered value records
(`value`, optional `interpolation`, optional `hint`). The invariant is
`segments.length === parameters.length + 1`. A parameter is never SQL, an
identifier, nested query, driver fragment, or tagged-template command.

The selected driver owns materialization. It converts the logical statement to
its transport (`$1`, `?`, `:1`, `@p1`, a named request, or a native value
template) only after pure binding description and hint validation. Placeholder
syntax is not a dialect or template-renderer concern.

---

## Result contracts

### Explicit contract

```ts
const query = sql.rows<AccountRow>`
  SELECT id, display_name AS "displayName"
  FROM accounts
`;
```

The developer owns the correspondence between arbitrary SQL and `AccountRow`. SQLBraid does not fabricate SQL-to-TypeScript inference.

Explicit result kinds are:

```ts
sql.rows<UserRow>`SELECT ...`
sql.command`UPDATE ...`
sql.call<RefreshResult>`CALL ...`
sql`SELECT ...` // Query<unknown, "unknown">
```

`RefreshResult` describes the whole `RoutineCallResult<Output, Sets, ReturnValue>`,
not one row. A routine contract can attach separate Standard Schema mappers to
`output`, each ordered `resultSets` entry and an actual `returnValue` channel:

```ts
const refresh = sql.call({
  output: RefreshOutputSchema,
  resultSets: [AccountSchema, SummarySchema] as const,
})`CALL refresh_accounts(${sql.inOut("accountId", accountId)})`;
const { output, resultSets } = await db.call(refresh);
```

OUT/INOUT support and required hints are driver-specific. PostgreSQL refcursors
require an existing `db.tx()`. Oracle supports scalar OUT/INOUT, REF CURSORs and
implicit results. MySQL supports heterogeneous emitted sets but rejects OUT/INOUT
descriptors: mysql2 does not expose the carrier metadata required for safe
classification. Tedious native procedure metadata separates OUTPUT from the
actual procedure RETURN status. SQLite has no stored-procedure `call()` API.
See the [routine guide](https://clickin.github.io/SQLBraid/dev/concepts/routines/).

Adapters report the actual row/command result kind and the runtime checks it against the declaration. A mismatch throws `BRAID_RESULT_KIND` **after execution**; use a transaction when a write must roll back if its declared kind was wrong.

### DML that returns rows

DML returning is a row contract, not a SQL-verb guess. Use a materialized row
API for native syntax supported by the selected database:

```ts
const inserted = await db.all(sql.rows<AccountRow>`
  INSERT INTO account (name)
  VALUES (${name})
  RETURNING id, name
`);
```

The native clauses stay visible and differ by dialect:

| Dialect | Native form | PV16 materialized contract |
| --- | --- | --- |
| PostgreSQL | `RETURNING` | `db.execute`, `db.all`, `db.one`, `db.maybeOne` with `sql.rows` |
| SQLite | `RETURNING` | same row APIs; SQLite accumulates output before delivery |
| MariaDB | `RETURNING` where the server supports the exact form | official Connector/Node.js evidence is separate from `mysql2` |
| SQL Server | `OUTPUT` | same row APIs; do not promise rollback-safe streaming |
| Oracle | `RETURNING ... INTO` plus `sql.out()` | adapter-specific OUT normalization |
| MySQL | no generic DML-returning clause | use a native MySQL statement or a separate query |

PV16 claims materialized DML-returning only. `db.stream()` for DML-returning is
not a portable support claim because drivers differ in buffering, statement
completion, cancellation, and rollback behavior. SQLBraid does not rewrite one
dialect's clause into another.

---

## Standard Schema result mapping

SQLBraid depends only on `@standard-schema/spec`. It does not require Valibot, Zod, ArkType or another concrete validator implementation.

### Query-bound mapper

```ts
const eventQuery = sql.rows(EventSchema)`
  SELECT created_at AS "createdAt", payload
  FROM events
`;

const event = await db.one(eventQuery);
```

The Standard Schema output type becomes the query row type.

A lightweight Valibot example:

```ts
import * as v from "valibot";

const EventSchema = v.object({
  createdAt: v.pipe(
    v.string(),
    v.regex(/^\d{14}$/),
    v.transform((s) =>
      new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`)
    ),
  ),
  payload: v.pipe(
    v.string(),
    v.parseJson(),
    v.object({ enabled: v.boolean() }),
  ),
});
```

Conceptually:

```text
database row
   ↓
driver + dialect TypePolicy normalization
   ↓
plain normalized row
   ↓
query-bound Standard Schema
   ↓
optional execution-level schema
   ↓
application model
```

Mapping is intrinsic to row queries: `execute`, `all`, `one`, `maybeOne`, `batch`, prepared queries, streams and transaction-scoped equivalents return mapped rows.

A per-execution schema remains additive:

```ts
await db.all(eventQuery, { schema: ExtraSchema });
```

Validation issues throw `DatabaseResultValidationError` (`BRAID_RESULT_VALIDATION`) with query/execution stage and row index. SQLBraid's own error message does not dump raw rows or binds.

Result mapping is intentionally one-row-to-one-row. SQLBraid does not provide identity maps, relation hydration or multi-row object-graph assembly.

---

## Database parameter hints are explicit; input codecs are deferred

Pre-release SQLBraid does not add a symmetric application input-codec framework.

```ts
${value}
```

remains an ordinary driver-bound value. When a database parameter type must be selected explicitly, use `sql.bind(value, hint)`; the hint is database typing metadata, not an input codec or Standard Schema validator. JavaScript database drivers do not expose a JDBC-like universal application-input type system, so `Temporal`, custom classes, JSON conventions and binary representations will be revisited only after real post-release requirements justify an input-mapping design.

---

## Runtime execution model

Current public row/command APIs include:

```ts
await db.all(query);
await db.one(query);
await db.maybeOne(query);
await db.execute(command);
await db.call(callQuery);
await db.batch(queries);
await db.bulk(inputs, (input) => sql.command`
  UPDATE account SET amount = ${input.amount} WHERE id = ${input.id}
`);
db.prepare(name, factory);
db.stream(query);
await db.tx(async (tx) => { ... });
```

The runtime tracks physical-resource ownership and prevents uncertain transaction state from being silently reused.

### Direct connections and pools

`createDatabase(executor, options?)` accepts one physical execution resource. Direct wrappers sharing an ownership key serialize their physical operations.

Pools have explicit factories; SQLBraid does not detect pools by duck typing:

```ts
import { Pool } from "pg";
import { createPool } from "mysql2/promise";
import { createPgDatabase, createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { createDatabase, createPooledDatabase } from "@sqlbraid/runtime";
import type { ConnectionProvider } from "@sqlbraid/core";

const direct = createPgDatabase(client); // connected pg.Client
const postgres = createPgPoolDatabase(new Pool(pgOptions));
const mysql = createMysql2PoolDatabase(createPool(mysqlOptions));
const custom = createPooledDatabase(provider); // ConnectionProvider
```

A `ConnectionProvider.acquire()` returns a `ConnectionLease`: one `QueryExecutor` plus `release({ discard? })`. Independent pooled root operations have no global SQLBraid queue. The application owns pool shutdown.

Outside an explicit transaction, a pooled database may obtain any available physical connection for each root operation:

```text
root query
  -> acquire lease
  -> execute DB I/O
  -> release lease
  -> application result mapping
```

`db.tx(...)` is the connection-pinning boundary:

```ts
await db.tx(async (tx) => {
  await tx.execute(insertAudit);
  await tx.execute(updateAccount);
});
```

Inside that closure, every `tx.*` operation reuses one physical connection until commit/rollback and release. Nested transactions use savepoints on the same connection when supported.

Use the innermost callback handle while a savepoint is active; parent/sibling handle use fails with `BRAID_TX_SCOPE`. Physical transaction operations are serialized. A callback must close its streams: an abandoned live iterator is closed and the transaction rolls back instead of committing over an active cursor.

### Environment evidence

Adapters may expose `db.environment({ targets? })` for an observed snapshot of
the database, driver, and capability profile. The probe uses the same normal
leased execution path and emits ordinary lifecycle events with
`purpose: "environment"`; it does not run hidden constructor I/O. A successful
snapshot is cached per database scope. Optional targets match only an exact
verified product/version/edition/driver/profile/runtime tuple; missing version
evidence remains `Compatible`, not `Official`. The support manifests and their
CI evidence remain the source of truth.

Using the outer/root database from its own transaction context fails with `BRAID_TX_SCOPE` instead of silently escaping onto another pool connection. Use the callback's `tx` handle, which becomes unusable after the closure ends.

A pool such as `pg.Pool`, `mysql2.Pool` or Bun.SQL must be modeled as a **connection provider/lease source**, not as a fake executor whose `BEGIN`, query and `COMMIT` could land on different connections.

Materialized query results release their root lease before asynchronous application mapping, including `execute`, prepared execution and `batch`.

One batch uses one lease, executes every physical statement in order, releases, then maps the materialized results. **Batch is not atomic:** earlier statements—and later statements when result mapping fails—may already have executed. Wrap it in `db.tx()` when atomicity is required.

### Homogeneous bulk DML

`db.bulk(inputs, factory)` accepts only `CommandQuery` values. It locks the
first rendered shape, rejects structural/cardinality or hint differences before
database I/O, then gives one physical lease and one parameter matrix to the
driver:

```ts
const result = await db.bulk(
  accounts.map(({ id, amount }) => ({ id, amount })),
  (input) => sql.command`
    UPDATE account
    SET amount = ${input.amount}
    WHERE id = ${input.id}
  `,
);
// { inputCount, affectedRows? }
```

An empty input returns `{ inputCount: 0 }` without acquiring a connection.
`db.bulk()` is a throughput primitive, not a portable transaction boundary:
there is no implicit transaction and no portable auto-chunking. Use
`db.tx(async (tx) => tx.bulk(inputs, factory))` when all changes must share the
callback transaction. Drivers report one of `native-bulk`, `pipeline`,
`prepared-loop`, or `remote-batch`; `db.bulk()` does not promise DML-returning
rows.

Streaming keeps its lease until iteration finishes, breaks, aborts or fails. Rows are mapped one at a time without buffering. Pooled-root mapper re-entry may acquire another lease; a pool needs available capacity for that nested operation. Same-root direct-stream re-entry fails with `BRAID_STREAM_SCOPE` rather than waiting on itself. Transaction streams prohibit overlapping work on the pinned connection.

First-party network and Node adapters have native streaming paths: optional `pg-cursor`,
mysql2 prepared `Execute.stream()`, SQLite `iterate()`, Oracle `ResultSet`, and
Tedious bounded row events; MariaDB uses its connector stream. Driver cleanup finishes before lease release. MySQL
normal break drains the command for reuse. PostgreSQL and MySQL abort terminate
and discard the physical connection, including pending reads. Cleanup failures
discard pooled leases or poison direct resources.
Custom executors must implement `stream()` explicitly, rejecting unsupported
capabilities rather than wrapping a materialized query. `callStream()` is not
available.

SQLite INTEGER storage is exposed as a canonical decimal string; native bigint
may be used internally by the Node/WASM drivers but is not a public integer
mode. REAL storage remains a JavaScript `number`, and D1 is guarded to the
safe-integer range. JavaScript JSON serialization therefore follows ordinary
string/number rules rather than requiring bigint encoding.

Uncertain transaction-control failures poison the physical resource. Pooled cleanup discards it (`pg` release-with-destroy; mysql2 `destroy()`); direct resources reject further SQLBraid work.

---

## Execution observers / interceptors

Production systems often need SQL/bind logging or audit without coupling SQLBraid to a logger.

Configure observers through `{ observers: [...] }` on direct or pooled database factories.

Coverage includes:

- derived parameterized SQL and lazy diagnostic `literalizedSql(options?)` views;
- readonly bind values and binding metadata;
- effective adapter, dialect, transport and reuse plan;
- declared and actual result kinds;
- query/call/batch/prepared lifecycle;
- DB execution duration in milliseconds (`durationMs`);
- row count/command metadata where appropriate;
- result-mapping completion;
- stream start/end/error;
- transaction begin/commit/rollback;
- savepoint lifecycle;
- errors with pipeline stage.

The public contract in `@sqlbraid/core` is a readonly discriminated event union:

```ts
interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}
```

Redact binds by default:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    onEvent(event) {
      if (event.type === "query:ready") {
        logger.debug({
          sql: event.sql,
          binds: event.values.map(() => "[REDACTED]"),
        });
      }
    },
  }],
});
```

An audit policy can fail closed before acquiring a connection:

```ts
const db = createPgPoolDatabase(pool, {
  observers: [{
    async onEvent(event) {
      if (event.type === "query:ready") {
        await audit.record({ operationId: event.operationId, sql: event.sql });
        // A rejected audit write prevents this SQL statement from executing.
      }
    },
  }],
});
```

Observers run sequentially in registration order. Events and metadata arrays are frozen where practical; nested application bind objects remain application-owned and must not be mutated. Prepared events carry the logical SQLBraid shape-lock name, not a promise of native driver preparation.

`literalizedSql(options?)` is a lazy, cached diagnostic reconstruction from
logical segments and parameters. It is not necessarily the protocol text and
must never be used as execution input. Redaction is the default; callers may
select inline/redacted values, maximum value length, binary summary/full output
and a custom redactor. Unsupported objects use a safe descriptive marker.
Parameterized and literalized views never search or replace `$1`, `?`, `:1` or
`@p1` in SQL text.
For `native-value-template` transports, the parameterized `sql` view may be
absent; use the literalized result only for diagnostics.

The event types are `query:ready`, `query:result`, `query:mapped`, `query:error`, `stream:start`, `stream:end` and `transaction`. Batch items use ordinary query events with a shared `batchId` and individual `operationId`s; this is the batch lifecycle representation rather than separate batch start/end events.

Pre-release observer semantics are **observe/fail only**:

- observers may inspect events;
- an observer may throw to reject/fail the operation;
- SQL, binds and results are not mutable through this SPI;
- retry/routing/query rewriting are not part of the observer contract.

Bind values are available because some audit systems require them, but SQLBraid does not log them by default. Applications decide their own redaction and retention policy.

A failure before DB execution prevents execution. A failure after DB execution cannot undo an already committed root side effect; inside `db.tx(...)`, propagated failures participate in rollback.

Binding/typed-request construction is a separate `materialize` stage and runs
before lease acquisition (`executionStarted` and `executionCompleted` are both
false on failure). Driver, server, and network failures remain `driver`.

If an error observer also fails, an `AggregateError` preserves the original failure and the observer failure. SQLBraid-generated errors do not stringify bind values; driver/application errors retain their original identity and may require application redaction.

This SPI is also the intended foundation for a later optional OpenTelemetry integration.

---

## Dialect, driver and runtime are separate

SQLBraid does not need a new dialect for every driver/runtime combination.

```text
dialect     PostgreSQL / MySQL / MariaDB / SQLite / Oracle / SQL Server SQL surface
driver      pg / mysql2 / mariadb / node:sqlite / sqlite-wasm / cloudflare-d1 /
            node-oracledb / Tedious / future alternatives
runtime     Node / Bun / Deno / Browser / Worker
```

Current first-party adapters and their transport ownership are:

| Dialect | Adapter | Transport/reuse owner |
| --- | --- | --- |
| PostgreSQL | `pg` | text-positional `$1..$N`; fresh unnamed simple execution |
| MySQL | `mysql2` | text-positional `?`; driver-owned reuse for every request |
| MariaDB | MariaDB Connector/Node.js | text-positional `?`; connector-owned reuse/batch |
| SQLite | `node:sqlite` | documented `?` prepare path; fresh simple execution |
| SQLite | `sqlite-wasm` | OO1 prepare/bind/step; direct browser resource |
| SQLite | `cloudflare-d1` | ordered placeholders; D1 remote batch |
| Oracle | `node-oracledb` Thin | text-positional `:1..:N`; driver cache reuse |
| SQL Server | Tedious | typed request `@p1..@pN`; fresh simple execution |

A different driver only needs a thin adapter/provider if the SQL dialect remains the same.
Custom adapter authors must preserve the logical statement value boundary and
provider/lease binding identity; see the [driver-author guide](./docs/driver-author-guide.md).
The requested reuse policy is not a promise about the effective strategy; the
adapter reports the effective result.

Transaction semantics are a separate, future **transaction profile**, not an
inference from dialect or driver. The execution runtime owns physical leases,
pinning and savepoint scope; Node/Bun/Deno describe its host. PV11 adds no
isolation API. The [reserved transaction architecture](./PLAN.md#84-reserved-transaction-profile-architecture)
keeps these concerns independent, including unusual protocol/dialect combinations.

Runtime support uses four labels:

- **Official** — exercised in SQLBraid CI for that runtime + driver;
- **Compatible** — no exact certified target, even if broader host or local-binding checks pass;
- **Custom** — connected through the executor/provider SPI.
- **Unsupported** — a required capability is absent or the combination fails SQLBraid's checks.

### Historical PV16 runtime evidence

The following table records the prior PV16 profile only. It is retained for
provenance and does not certify the changed PV17 value-fidelity contract.

| Runtime | core/template/runtime | Tested version | Notes |
| --- | --- | --- | --- |
| Node | Official | 22.18.0 | Pinned release and packed-runtime gates |
| Node | Compatible | 24.21.0 | Full-suite/finance CI evidence; no separate certified target |
| Bun | Official | 1.3.14 | Packed core/runtime and pg/mysql2 host paths |
| Deno | Official | 2.9.3 | Packed core/runtime, pg/mysql2 and node:sqlite host paths |
| Browser | Official | Chromium 153.0.8010.12 | SQLite WASM 3.53.4, native int64/CAPI transport with string output (historical PV16 evidence; PV17 gate pending) |
| Worker | Compatible | workerd 1.20260730.1 | Local D1 binding verified; managed SQLite version unreported |

### First-party driver host support

Host portability does not extend the database versions or native capabilities
certified by the [target manifests](./support/targets/).

| Adapter | Node 22.18.0 | Node 24.21.0 | Bun 1.3.14 | Deno 2.9.3 |
| --- | --- | --- | --- | --- |
| PostgreSQL / `pg` 8.23.0 | Official | Compatible | Official | Official |
| MySQL / `mysql2` 3.24.4 | Official | Compatible | Official | Official |
| MariaDB / Connector 3.5.4 | Official | Compatible | Unsupported | Unsupported |
| SQLite / `node:sqlite` | Official | Compatible | Unsupported | Official |
| SQLite / `sqlite-wasm` | Unsupported | Unsupported | Unsupported | Unsupported |
| SQLite / `cloudflare-d1` | Unsupported | Unsupported | Unsupported | Unsupported |
| Oracle Thin / `node-oracledb` 7.0.1 | Official | Compatible | Unsupported | Unsupported |
| SQL Server / Tedious 20.0.0 | Official | Compatible | Unsupported | Unsupported |

The [development documentation's exact-SHA evidence](https://clickin.github.io/SQLBraid/dev/reference/support/#release-evidence-provenance),
[current runtime runs](https://github.com/Clickin/SQLBraid/actions/workflows/runtime-portability.yml?query=branch%3Amain)
and [immutable release workflow](https://github.com/Clickin/SQLBraid/actions/workflows/release.yml)
are the release evidence entrypoints. Match a future run's commit SHA to the
artifact you use; PV17 currently has no final run ID or exact-SHA claim.
Historical PostgreSQL/MySQL, Bun/Deno, and SQLite host checks remain historical
only. No SQL keyword classifier or substitute SQLite driver is used.

Compiler, CLI, language server, and metadata/codegen tooling remain **Node-first**.
Other drivers remain **Custom** through `QueryExecutor` / `ConnectionProvider`.

Direct `createPgDatabase()` accepts physical `Client`/`PoolClient`, not `pg.Pool`.
Direct `createMysql2Database()` accepts a Promise `Connection`/`PoolConnection`,
not a pool. Type checks and immediate runtime guards enforce this boundary;
use the corresponding `create*PoolDatabase()` factory for pools.
Observer errors distinguish `cardinality` from `result-kind`; all public timing
fields are named `durationMs`, with no former-name alias.

---

## Metadata and code generation

Database metadata is optional, Node-first development tooling. Runtime dialect
imports do not install or require `@sqlbraid/metadata` or `@sqlbraid/codegen`.

| Layer | Owns |
| --- | --- |
| Standard Schema | Application row validation/transformation |
| `@sqlbraid/metadata` | Introspected database structure and database type facts |
| TypePolicy | Runtime primitive representation policy |
| `@sqlbraid/codegen` | Metadata + selected TypePolicy → deterministic table-oriented TS `Row`/`Insert`/`Update` models |

For inspection, install `@sqlbraid/metadata` explicitly alongside the dialect and
driver, and use the dedicated inspector subpath:

```ts
import { hashSnapshot, validateSnapshot } from "@sqlbraid/metadata";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";

// client is an already-connected pg.Client.
const metadata = await createPostgresInspector(client).inspect();
validateSnapshot(metadata);
const hash = hashSnapshot(metadata);
```

MySQL and SQLite expose `@sqlbraid/mysql/inspector` and
`@sqlbraid/sqlite/inspector`. Inspectors are not exported from dialect roots.
The metadata relationship is an optional peer dependency.

`MetadataSnapshot` uses `format: "sqlbraid-metadata"` and `formatVersion: 1`.
Old discriminator-less snapshots are rejected; there is no compatibility parser
or speculative migration API. Canonicalization/hash/drift ignore capture
timestamps while preserving database facts. `sqlbraid drift --before ... --after ...`
validates this format. LSP `createLanguageService({ metadata })` enables database
completion; diagnostics and declared-contract hover work without metadata.

Identity means proven database identity/autoincrement generation, not primary-key
membership. Computed columns carry generated/write restrictions where proven;
absent write flags mean unknown. Inspectors do not choose TypeScript types.

### Programmatic model generation

Install `@sqlbraid/codegen` explicitly. Pass an inspected or parsed
`MetadataSnapshot` and the TypePolicy selected for your application:

```ts
import { generateModels } from "@sqlbraid/codegen";
import { typePolicy } from "@sqlbraid/postgres";

const generated = generateModels(metadata, {
  typePolicy,
  filters: { includeNamespaces: ["public"] },
  naming: { relations: { "public.user_account": "User" } },
  typeOverrides: {
    columns: {
      "public.events": {
        created_at: { outputType: 'import("./domain.js").CompactDateTime' }
      }
    }
  }
});
console.log(generated.source);
```

The generator is pure and offline: no filesystem writes, DB connection, config
lookup or codec execution. Exact relation filters, model-name overrides,
custom suffixes and exact database-type/column type overrides are available.
Override precedence is column > database type > TypePolicy, with input and
output representations resolved independently. It returns standalone
TypeScript source, model names, diagnostics, metadata/policy provenance and an
options hash. Map insertion order and capture timestamps do not affect bytes.

- **Row** uses TypePolicy `outputType`; DB column nullability controls `| null`.
- **Insert** uses `inputType`. Nullable/default/identity columns are optional;
  generated or explicitly non-insertable columns are excluded.
- **Update** uses `inputType`, with all included properties optional. Generated
  or explicitly non-updatable columns are excluded; identity alone is not a ban.
- Only tables receive write models. Views, materialized views, foreign and
  virtual relations receive Row models; unknown kinds with columns receive a
  Row model and warning.

PostgreSQL qualified types resolve through explicit metadata type-name evidence;
MySQL policy keys match case-insensitively. SQLite STRICT declarations use the
selected primitive policy (`INT` also resolves through `INTEGER`); non-STRICT
columns use explicit column/DB-type overrides or remain `unknown` with warnings;
declared affinity never supplies automatic TypePolicy mapping there.
Unsupported types also remain `unknown`,
never an inferred application type. Column names survive as quoted property keys;
namespace evidence and stable identity suffixes disambiguate model names.

Invalid metadata throws `SnapshotValidationError`; malformed TypePolicy or
override input throws `TypeError`. Conflicting normalized policy entries produce
`CODEGEN_AMBIGUOUS_TYPE_MAPPING` error diagnostics and affected types remain
`unknown`. Invalid/colliding explicit names produce error diagnostics rather than
silently changing the requested name. Inspect diagnostics before using the
source. Unresolved evidence remains `unknown`, never `any`.

### CLI generation

Create an executable Node config (`.mjs`, `.js`, or `.cjs`; TypeScript configs
are not supported):

```js
import { defineConfig } from "@sqlbraid/cli/config";
import { typePolicy } from "@sqlbraid/postgres";

export default defineConfig({
  codegen: {
    targets: [{
      name: "main",
      metadata: "./db/main.metadata.json",
      outFile: "./src/generated/database.ts",
      typePolicy,
      filters: { includeNamespaces: ["public"] }
    }]
  }
});
```

Run `sqlbraid codegen`, or `sqlbraid codegen --config ./sqlbraid.config.mjs`.
Metadata and output paths are relative to the config file. Use repeated
`--target` to select targets, `--check` as a CI freshness gate, and `--json`
for one structured result document. Validation completes for every selected
target before any output is written; unchanged files keep their mtime.
JSON reports `written` only after successful I/O. Final Row/Insert/Update names
are globally collision-checked; Windows output collision keys are case-folded.

The config is executable application code and is not sandboxed. Type overrides
change generated TypeScript only; they do not transform driver values. Column
names remain exact database keys, and arbitrary SELECT/JOIN inference remains
outside codegen.

## Agent-native LSP and editor tooling

`sqlbraid-language-server [--config <path>]` is a standard stdio LSP server,
using `vscode-languageserver`, not a VS Code-specific protocol. It consumes
`rootUri`/workspace folders and project `tsconfig`, and discovers the same
`.mjs`/`.js`/`.cjs` SQLBraid config as codegen. Imports from template, PostgreSQL,
MySQL and SQLite packages are recognized.

| Standard operation | SQLBraid evidence |
| --- | --- |
| Diagnostics (push/pull) | Braid errors and mapped overlay-only TS errors; ordinary TS remains TSServer-owned |
| Completion | Metadata candidates in static SQL only, never ordinary TS or `${...}` |
| Hover | Query contract/binds/dialect; known DB relation, column or routine facts and provenance |
| Definition | Current generated declaration/property, otherwise reliable metadata JSON location |
| References | Positive lexical identity only; ambiguous CTE/alias occurrences are omitted |
| Document/workspace symbols | Query units and filtered metadata/generated declarations |
| Signature help | Only routines with `argumentsComplete: true` |

Metadata is **open-world positive evidence**. Absence never proves a table,
column, routine or type invalid. Built-ins, extension routines, runtime UDFs,
temporary objects and CTEs remain legal opaque SQL. PostgreSQL/MySQL inspectors
currently report `argumentsComplete: false`; an empty argument list is not a
zero-arity claim. SQLite emits no routine records.

Uncertain lexical contexts return less intelligence, not SQL errors. Unqualified
column navigation is limited to direct `SELECT column FROM` evidence; use
qualified references for other supported column lookups. Quoted PostgreSQL
identifiers retain case, and MySQL double-quoted literals stay opaque without
ANSI_QUOTES evidence. The tooling
does not reconstruct a SQL AST or infer arbitrary SELECT results. Generated
navigation checks actual current source; stale/missing output never receives
invented offsets. `sqlbraid codegen --check` remains the freshness authority.

For agents without LSP:

```bash
sqlbraid inspect query --file src/query.ts --line 8 --column 20 --json
sqlbraid inspect symbol UsersRow --json
sqlbraid inspect diagnostics --file src/query.ts --json
```

Positions are 1-based in CLI and standard 0-based in LSP. JSON results are
focused and bounded; unresolved query evidence uses `resolved: false`, not
invalid-SQL claims. The [portable agent skill](./skills/sqlbraid/SKILL.md)
documents LSP-first/CLI-fallback use and generated-file discipline.

The dependency direction is:

```text
core / compiler / metadata / codegen
                 ↓
        @sqlbraid/tooling
           ↙           ↘
         CLI     language-server
                         ↑
                 thin VS Code client
```

The shared tooling package owns config loading, workspace evidence and semantic
indexes. `@sqlbraid/cli/config` intentionally reexports its config contract.
Runtime packages acquire none of these dependencies. Config runs as trusted
Node code in disposable workers to bound module-cache lifetime; workers are
not a sandbox. Per-workspace caches track source/config/metadata/generated
changes. Requests stat cached disk evidence even without client watchers;
capable LSP clients also receive standard file-watch registration. Pending work
is shared without letting one cancelled caller abort another; disposal terminates
in-flight config workers and obsolete results are discarded.
Synchronous TypeScript work is not preemptible.

`extensions/vscode` targets VS Code `>=1.121.0`, whose tested host provides Node
`22.22.1`, and is a thin TypeScript/TSX client. It starts the server only
for config/dependency-proven SQLBraid projects, keeps built-in TypeScript support,
and offers **Generate Models**, **Check Generated Models**, and **Reload Project**.
The VSIX contains matching `0.1.0-rc.0` server/CLI dependencies with version checks;
it never silently selects a global/workspace server. No semantic engine lives in
the extension. The full gate runs a real VS Code host and packs the VSIX.

---

## Oracle and SQL Server evidence

PV13's [successful runtime gate at d4bc626](https://github.com/Clickin/SQLBraid/actions/runs/34753809318) covers the historical Oracle 23.9.0.25.07 Thin and SQL Server 2022 CU18 (16.0.4185.3) baseline with Node 22.18.0 on Linux x64, plus all five portable dialect roots on Node/Bun/Deno. It is not evidence for PV15 routine additions. Local SQL Server ARM emulation is not an Official ARM claim. New routine/streaming capabilities require exact-final-revision CI; Oracle Thick and Oracle/Tedious on Bun/Deno remain outside that claim.

## Vite 8 and TanStack Start

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({ plugins: [sqlbraid()] });
```

The pre-transform lowers guarded Braid expressions and preserves source maps;
Vite remains responsible for TypeScript/JSX transpilation. Keep database drivers,
connections and query execution in server-only modules. This is build integration,
not browser support for SQLBraid runtime packages.

`pnpm run test:tanstack-start` validates a packed Node 24 / TanStack Start finance
consumer: Vite dev/build/HMR, SSR, Korean STRICT SQLite tables, integer modes and
client/server bundle boundaries.

---

## Packages

Current workspace packages:

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts and Standard Schema-facing types |
| `@sqlbraid/template` | Tagged templates, directives and rendering |
| `@sqlbraid/runtime` | Execution, mapping, result-kind safety, transactions and streaming |
| `@sqlbraid/postgres` | PostgreSQL dialect/TypePolicy; `/pg` adapter; optional `/inspector` |
| `@sqlbraid/mysql` | MySQL dialect/TypePolicy; `/mysql2` adapter; optional `/inspector` |
| `@sqlbraid/mariadb` | MariaDB dialect/TypePolicy; official connector `/mariadb` adapter |
| `@sqlbraid/sqlite` | SQLite dialect; `/node-sqlite`, `/wasm` and `/d1` adapters; optional `/inspector` |
| `@sqlbraid/oracle` | Oracle dialect/TypePolicy and parameter hints; `/oracledb` adapter; optional `/inspector` |
| `@sqlbraid/mssql` | SQL Server dialect/TypePolicy and parameter hints; `/tedious` adapter; optional `/inspector` |
| `@sqlbraid/compiler` | TypeScript discovery and guarded-template lowering |
| `@sqlbraid/vite` | Vite 8 pre-transform, diagnostics and original-source maps |
| `@sqlbraid/metadata` | DB-fact snapshots, validation, canonical identity and drift |
| `@sqlbraid/codegen` | Pure metadata + TypePolicy to Row/Insert/Update declarations |
| `@sqlbraid/tooling` | Shared config/workspace, evidence indexes and agent/editor semantics |
| `@sqlbraid/operations` | Fingerprints and provisional declaration manifests |
| `@sqlbraid/cli` | Command-line tooling |
| `@sqlbraid/language-server` | Editor/LSP integration |
| `sqlbraid` | Unscoped CLI convenience package; provides the `sqlbraid` executable without database drivers |

The workspace package set is 18 packages: 17 scoped packages plus the unscoped `sqlbraid` CLI convenience package.

---

## Roadmap

Completed:

1. **PV1** — explicit query/result-kind contracts;
2. **PV2** — remove compiler SQL semantic inference;
3. **PV3** — remove broad SQL AST/resolver;
4. **PV4** — runtime result-kind enforcement + execution-time Standard Schema validation;
5. **PV5** — query-bound Standard Schema result mapping;
6. **PV6** — execution boundary, connection leasing/transaction pinning, SQL/bind/audit observer SPI;
7. **PV7** — Node/Bun/Deno runtime portability matrix and clean-checkout CI closure;
8. **PV8** — metadata v1 DB-fact model, inspector subpaths and runtime/tooling dependency separation;
9. **PV9** — pure, deterministic programmatic metadata + TypePolicy → TypeScript codegen;
10. **PV10** — codegen CLI/overrides and correctness closure;
11. **PV11** — open-world agent-native LSP, shared CLI JSON and thin VS Code client.

Next:

12. **PV12** — public API/docs/package hardening for pre-release/Product Hunt.
13. **PV13** — five-DB typed parameter hints, Oracle/SQL Server integrations, localized/versioned docs, tooling registry, and unscoped CLI bootstrap; release claims remain evidence-gated.

Post-release candidates include application input mapping/codecs, optional DB verification, additional driver adapters, cancellation, bulk/pipeline operations, query transformation, routing/retry and OpenTelemetry.

---

## Development

Requirements:

- Node.js `>=22.18.0` for the current published packages;
- pnpm `12.x`;
- Docker for PostgreSQL/MySQL integration tests.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:db
pnpm run test:consumer
pnpm run test:all
pnpm run pack:check
pnpm run test:runtime
pnpm run test:lsp
pnpm run test:agent-tooling
pnpm run test:vscode
```

`test:all` includes the real VS Code host gate. Headless Linux needs `xvfb-run`;
the host runner downloads pinned VS Code `1.121.0` unless
`SQLBRAID_VSCODE_EXECUTABLE` selects an installed test executable. Local macOS
uses the standard installed VS Code path when present.

`test:runtime:node`, `test:runtime:bun`, and `test:runtime:deno` run individual cells.
The Node/pnpm orchestrator builds and packs runtime packages, installs an isolated
consumer, audits source/distribution and Node-ambient-free declarations, and runs
the same scripts under each runtime. It starts disposable PostgreSQL/MySQL
Testcontainers unless `SQLBRAID_POSTGRES_URL` / `SQLBRAID_MYSQL_URL` identify
dedicated test databases. The smoke creates and drops isolated test tables;
**never point it at a non-test database**. CI supplies service containers.
Deno uses `--no-prompt`, consumer-scoped `--allow-read`, DB endpoint-scoped
`--allow-net`, and `--allow-env=SQLBRAID_POSTGRES_URL,SQLBRAID_MYSQL_URL,PG*,NODE_*,USER,USERNAME,TZ`.
It needs no `-A`, subprocess, write, or FFI permission.

Read [`PLAN.md`](./PLAN.md) for the authoritative roadmap and [`AGENTS.md`](./AGENTS.md) before broad architectural changes.
