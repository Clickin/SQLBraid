# SQLBraid

**Write SQL. Keep TypeScript. Skip the query-builder translation layer.**

SQLBraid is a SQL-first data-access toolkit for TypeScript. It lets you write ordinary SQL in tagged templates, add readable inline dynamic clauses, bind values safely, declare result contracts, and execute through first-party PostgreSQL, MySQL, and SQLite adapters.

```ts
interface UserRow {
  id: number;
  name: string;
  email: string | null;
}

const users = sql.rows<UserRow>`
  SELECT u.id, u.name, u.email
  FROM users u

  /*@braid where*/
    /*@braid if ${name != null}*/
      AND u.name = ${name}
    /*@braid end*/
  /*@braid end*/

  ORDER BY u.id
`;
```

SQL stays readable from top to bottom. JavaScript values stay bound parameters. Dynamic SQL stays next to the SQL it controls.

> **Status:** pre-release. The core runtime, template engine, guarded compiler transform, result-kind enforcement, query-bound Standard Schema mapping, execution-time validation, dialect adapters, real DB tests, and package toolchain are implemented. Metadata package cleanup is next. See [`PLAN.md`](./PLAN.md).

---

## Why SQLBraid?

TypeScript database libraries often ask you to choose between two extremes:

- use a low-level driver and give up most higher-level ergonomics; or
- translate SQL into a TypeScript query-builder/ORM API.

SQLBraid takes a different approach: **SQL is already the query language.**

The toolkit focuses on the layers around SQL:

- safe parameter binding;
- inline dynamic SQL;
- explicit TypeScript result contracts;
- optional result validation/transformation;
- plain JavaScript results;
- transactions and execution helpers;
- optional metadata/code-generation tooling.

SQLBraid does not need to understand every database function or extension before you can use it.

```ts
const report = sql.rows<ReportRow>`
  SELECT
    custom_company_score(account_id) AS score,
    jsonb_build_object('id', account_id) AS metadata
  FROM reporting_view
`;
```

If your database accepts the SQL, SQLBraid should not force you to wait for a local function registry to catch up.

---

## SQL-first by design

SQLBraid is not an ORM and does not make a fluent query builder the primary API.

```ts
const query = sql.rows<UserRow>`
  SELECT id, name, email
  FROM users
  WHERE organization_id = ${organizationId}
  ORDER BY name
`;
```

Ordinary interpolation always becomes a bound value. It is never concatenated into the SQL string.

For SQL structure, use explicit helpers:

```ts
sql.ident(columnName)
sql.fragment`ORDER BY created_at DESC`
sql.list(ids)
sql.join(parts, sql.fragment`, `)
sql.raw(trustedSql)
```

`sql.raw()` is intentionally explicit: it is the escape hatch for trusted structural SQL.

---

## Dynamic SQL without leaving the statement

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

First-match branching is also supported:

```ts
const query = sql.rows<UserRow>`
  SELECT id, name
  FROM users

  /*@braid where*/
    /*@braid choose*/
      /*@braid when ${id != null}*/
        AND id = ${id}
      /*@braid when ${email != null}*/
        AND email = ${email}
      /*@braid otherwise*/
        AND active = ${true}
    /*@braid end*/
  /*@braid end*/
`;
```

The compiler transform preserves lazy evaluation for guarded TypeScript expressions. Disabled branches do not eagerly evaluate their guarded values.

The directive language is deliberately small. SQLBraid is not trying to embed another general-purpose language inside SQL.

---

## Result contracts

### Explicit contract

```ts
interface AccountRow {
  id: bigint;
  displayName: string;
  disabledAt: Date | null;
}

const query = sql.rows<AccountRow>`
  SELECT id, display_name AS "displayName", disabled_at AS "disabledAt"
  FROM accounts
`;
```

The application declares the row shape it expects.

This is intentionally similar to the practical contract used by SQL mapping frameworks: SQLBraid does not locally prove that arbitrary SQL produces the declared model.

A bare query remains unknown:

```ts
const query = sql`SELECT ...`;
// Query<unknown, "unknown">
```

Explicit result kinds are:

```ts
const rows = sql.rows<UserRow>`SELECT id, name FROM users`;
const command = sql.command`UPDATE users SET active = ${true}`;
const call = sql.call<RefreshResult>`CALL refresh_users()`;
```

The bare `sql<Row>` shorthand is not supported.

---

## Runtime result-kind safety

Adapters report the actual database result kind. The shared runtime compares it with the query declaration.

```ts
const result = await db.execute(sql.command`
  UPDATE users SET active = true
`);

if (result.kind === "command") {
  console.log(result.command.affectedRows);
}
```

A mismatch throws `DatabaseResultKindError` with code `BRAID_RESULT_KIND`.

This check happens **after database execution**. It is an assertion on the returned result, not a pre-execution SQL verifier. Use a transaction when a write must roll back if its declared result kind was wrong.

Routine calls use `db.call()` and are intentionally excluded from generic `execute()` and `batch()`.

---

## Standard Schema: choose your own implementation

SQLBraid uses the **Standard Schema protocol** as the interoperability boundary for result validation and transformation.

SQLBraid depends only on `@standard-schema/spec` for the protocol types; it does not require Valibot, Zod, ArkType, or another concrete validator library.

You choose the implementation that fits your application.

### Execution-time validation

Row APIs accept Standard Schema-compatible validators:

```ts
const users = await db.all(query, {
  schema: UserSchema,
});
```

`all`, `one`, `maybeOne`, and `stream` accept `{ schema }`; prepared row helpers accept it on `all`, `one`, and `maybeOne`.

Validation may be synchronous or asynchronous. Transformed schema output is returned. `one` and `maybeOne` enforce cardinality before validation, while streams validate row-by-row before each yield.

### Query-bound result mapping

Bind a mapper directly to the query definition:

```ts
const query = sql.rows(UserSchema)`
  SELECT
    id,
    created_at AS "createdAt",
    payload
  FROM events
`;
```

The Standard Schema **output type** becomes the query row type.

For example, choose Valibot to turn a compact UTC timestamp and JSON text into application values:

```ts
import * as v from "valibot";
import { sql } from "@sqlbraid/postgres";

const EventSchema = v.object({
  createdAt: v.pipe(
    v.string(),
    v.regex(/^\d{14}$/),
    v.transform((s) =>
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`
    ),
    v.isoTimestamp(),
    v.transform((s) => new Date(s)),
  ),
  payload: v.pipe(
    v.string(),
    v.parseJson(),
    v.object({ enabled: v.boolean() }),
  ),
});

const eventQuery = sql.rows(EventSchema)`
  SELECT '20260912191500' AS "createdAt", '{"enabled":true}' AS payload
`;
const event = await db.one(eventQuery);
// { createdAt: Date, payload: { enabled: boolean } }
```

This enables application-level transformations such as:

```text
VARCHAR(14) yyyyMMddHHmmss -> Temporal.PlainDateTime
TEXT JSON                  -> typed object
json/jsonb                  -> validated domain object
legacy string code          -> application value object
```

without a SQLBraid-specific result-map DSL.

Conceptually:

```text
database row
   ↓
driver + dialect TypePolicy normalization
   ↓
plain normalized row
   ↓
query-bound Standard Schema
validate + transform
   ↓
application model
```

A per-execution `{ schema }` remains additive and runs after the query-bound mapper.

Mapping is intrinsic to row queries: `execute`, `all`, `one`, `maybeOne`, `batch`, prepared queries, streams, and transaction-scoped equivalents all return mapped rows. `one`/`maybeOne` check raw cardinality first; multi-row operations process schemas sequentially, and streams do not buffer the full result.

Validation issues throw `DatabaseResultValidationError` (`BRAID_RESULT_VALIDATION`) with `stage: "query" | "execution"`, `issues`, and zero-based `rowIndex`. Validator-thrown exceptions propagate unchanged. SQLBraid's own message contains no raw rows or binds.

The mapper is query metadata, not rendered SQL: different mappers can share SQL and fingerprints. Reusing `const eventRows = sql.rows(EventSchema)` preserves the schema reference. Guarded compiler lowering evaluates a schema expression once, before active interpolations.

### Validator choice remains yours

Valibot is a natural lightweight option, while Zod, ArkType, and other Standard Schema-compatible libraries work as well.

Valibot, Zod, and a handwritten Standard Schema implementation are covered by interoperability tests. No concrete validator is bundled or required.

---

## Result mapping is intentionally one-row-to-one-row

SQLBraid result mapping may:

- validate fields;
- transform values;
- parse JSON/text;
- build temporal or domain values;
- reshape a single row.

It does not perform ORM-style multi-row graph assembly, identity maps, relation hydration, lazy entities, or collection merging.

If you need nested data, ordinary SQL aliases, JSON aggregation, or a Standard Schema transform can shape a row without turning SQLBraid into an ORM.

---

## Input mapping is deferred

Pre-release SQLBraid deliberately does **not** add a symmetric application input-mapper framework.

JavaScript database drivers do not provide a JDBC-like universal application-input type model. Supporting arbitrary `Temporal`, classes, custom objects, JSON conventions, binary values, and driver-specific inputs would require a much broader encoding policy.

For now:

```ts
${value}
```

remains a normal bound value handled by the dialect/driver boundary.

Application-level input codecs may be reconsidered after pre-release based on real use cases.

---

## Runtime API

SQLBraid returns plain results and provides cardinality helpers:

```ts
const rows = await db.all(query);
const row = await db.one(query);
const maybe = await db.maybeOne(query);
const result = await db.execute(command);
```

Execution results are discriminated:

```text
rows    -> typed rows
command -> empty rows + command payload
unknown -> actual rows or command result
```

Transactions use a transaction-scoped database handle:

```ts
await db.transaction(async (tx) => {
  await tx.execute(insertAudit);
  await tx.execute(updateAccount);
});
```

The runtime tracks ownership by physical execution resource so independent wrappers cannot accidentally leak work into another transaction. Failed transaction-control cleanup poisons the affected resource instead of silently reusing uncertain state.

---

## Dialects

First-party packages target:

- PostgreSQL via `pg`
- MySQL via `mysql2`
- SQLite via `node:sqlite`

Dialect packages own:

- placeholders;
- identifier quoting;
- driver execution;
- transactions/savepoints;
- primitive type normalization through `TypePolicy`;
- result normalization;
- optional database metadata inspection.

Application semantic transforms such as compact-string dates or domain JSON belong in result schemas, not in dialect TypePolicy.

---

## Metadata and code generation

Database metadata is optional development tooling.

The current `@sqlbraid/schema` package contains metadata/snapshot structures. Before public pre-release, the roadmap plans to rename/reframe it as:

```text
@sqlbraid/metadata
```

A later optional package:

```text
@sqlbraid/codegen
```

will generate deterministic table-oriented TypeScript models such as `Row`, `Insert`, and `Update` shapes.

Codegen is not required for normal SQLBraid authoring and will not become a runtime/compiler dependency.

The first codegen scope does not promise arbitrary SELECT/JOIN result inference.

---

## Database verification

A prepare/describe DB verifier is **not** part of the pre-release core roadmap.

If later demand justifies it, it should be optional development tooling using real database evidence, not a local SQL semantic engine.

The current product does not require a verifier to use explicit contracts or Standard Schema result mapping.

---

## Packages

Current workspace packages:

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts, execution result types, Standard Schema-facing types |
| `@sqlbraid/template` | Tagged templates, directives, rendering, structural helpers |
| `@sqlbraid/runtime` | Execution, result-kind enforcement, result validation/mapping, cardinality, transactions, prepared/streaming seams |
| `@sqlbraid/postgres` | PostgreSQL dialect, TypePolicy, inspector, `pg` adapter |
| `@sqlbraid/mysql` | MySQL dialect, TypePolicy, inspector, `mysql2` adapter |
| `@sqlbraid/sqlite` | SQLite dialect, inspector, `node:sqlite` adapter |
| `@sqlbraid/compiler` | TypeScript source discovery and guarded-template transform |
| `@sqlbraid/schema` | Database metadata/snapshot structures; planned PV6 rename to `@sqlbraid/metadata` |
| `@sqlbraid/operations` | Fingerprints and provisional declaration manifests |
| `@sqlbraid/cli` | `sqlbraid` command-line tools |
| `@sqlbraid/language-server` | Editor/LSP integration |

Planned optional development tooling:

```text
@sqlbraid/codegen
```

---

## Roadmap

Completed:

1. **PV1** — explicit query/result-kind contracts;
2. **PV2** — remove compiler SQL semantic inference;
3. **PV3** — remove broad SQL AST/resolver;
4. **PV4** — runtime result-kind enforcement + execution-time Standard Schema validation;
5. **PV5** — query-bound result mapping via Standard Schema.

Next:

6. **PV6** — rename/reframe database schema snapshots as metadata;
7. **PV7** — optional table metadata → TypeScript codegen;
8. **PV8** — codegen CLI, naming and type overrides;
9. **PV9** — LSP metadata/codegen integration;
10. **PV10** — public API/docs/package hardening for pre-release/Product Hunt.

Post-pre-release candidates include input mapping, optional DB verification tooling, pool leasing, cancellation, bulk/pipeline operations, routing/retry, and telemetry.

---

## Development

Requirements:

- Node.js `>=22.18.0`
- pnpm `12.x`
- Docker for PostgreSQL/MySQL integration tests

Common commands:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:db
pnpm run test:consumer
pnpm run test:all
pnpm run pack:check
```

The integration suite uses Testcontainers for PostgreSQL/MySQL and native `node:sqlite` for SQLite.

Published-package checks include packed external consumers, ESM/type resolution, subpath exports, CLI/language-server execution, `publint`, and Are The Types Wrong.

---

## Design principles

1. **SQL stays SQL.**
2. **Values are bound by default.**
3. **Dynamic SQL remains local and readable.**
4. **Explicit contracts beat fabricated inference.**
5. **Standard Schema is the result-mapping interoperability boundary.**
6. **Users choose the validation/transform implementation.**
7. **Dialect adapters stay thin.**
8. **Metadata/codegen stays optional.**
9. **Offline development stays possible.**
10. **Complexity must earn its place in the product.**

---

## Contributing

Read [`PLAN.md`](./PLAN.md) for product scope and [`AGENTS.md`](./AGENTS.md) for repository engineering rules before making broad architectural changes.

The most important contribution rule is simple: **do not grow SQLBraid into a partial database compiler, ORM mapper framework, or validator library when an explicit contract or ecosystem protocol already solves the problem.**
