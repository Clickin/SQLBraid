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

    /*@braid if ${active != null}*/
      AND u.active = ${active}
    /*@braid end*/
  /*@braid end*/

  ORDER BY u.id
`;
```

SQL stays readable from top to bottom. JavaScript values stay bound parameters. Dynamic SQL stays next to the SQL it controls.

> **Status:** pre-release. The core runtime, template engine, compiler transform, dialect adapters, Testcontainers integration, and package toolchain are implemented. The public API is being simplified around the product contract described in [`PLAN.md`](./PLAN.md).

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
- plain JavaScript row objects;
- transactions and execution helpers;
- runtime validation when you want it;
- database-assisted verification when you want stronger guarantees.

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

### Conditional clauses

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

### First-match branching

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

The directive language is deliberately small. SQLBraid is not trying to embed a second general-purpose language inside SQL.

---

## Result contracts

SQLBraid's v1 type strategy is intentionally practical.

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

A query without a declared or generated contract remains `Query<unknown, "unknown">` rather than receiving a guessed type.

Use `sql.rows<Row>\`...\`` for an explicit row contract. Use explicit helpers when the result kind is not a row query:

```ts
const rows = sql.rows<UserRow>`SELECT id, name FROM users`;
const command = sql.command`UPDATE users SET active = ${true}`;
const call = sql.call<RefreshResult>`CALL refresh_users()`;
```

These tags carry their result kind at runtime, with or without the compiler transform. The bare `sql<Row>` shorthand is not supported.

An untyped `sql\`...\`` is `Query<unknown, "unknown">`; pass it to `db.execute()` only, or declare its kind explicitly.

Static templates work with ordinary TypeScript compilation. Guarded interpolations require the SQLBraid transform for lazy evaluation and control-flow narrowing.

`sqlbraid check` and `sqlbraid build` do not require a schema snapshot. They check TypeScript contracts and Braid directives, not SQL semantics: custom functions, operators, and vendor SQL pass through without local type inference. A declared result contract is not database verification.

### Runtime validation

For stronger runtime guarantees, SQLBraid can integrate with Standard Schema-compatible validators. This is useful when database output crosses a trust boundary or when custom database types/functions make static verification impractical.

### Database verification

The roadmap includes an opt-in verification workflow that asks the real database for metadata whenever the dialect/driver provides trustworthy evidence.

The intended workflow is:

```text
write SQL + declare contract
        ↓
normal offline TypeScript development
        ↓
optional sqlbraid verify against a real DB
        ↓
versioned query manifest for CI/offline checks
```

The database, not a partial reimplementation of its SQL grammar, is the authority for database-specific semantics.

---

## Dialects

First-party packages target:

- PostgreSQL via `pg`
- MySQL via `mysql2`
- SQLite via `node:sqlite`

Each dialect owns the parts that actually differ at the driver boundary:

- placeholders;
- identifier quoting;
- driver execution;
- transactions/savepoints;
- type codecs;
- result normalization;
- optional metadata/verification capabilities.

The goal is to keep dialect support thin. Adding a database should not require teaching the compiler every function and operator in that database.

---

## Runtime API

SQLBraid returns plain rows and provides cardinality helpers:

```ts
const rows = await db.all(query);
const row = await db.one(query);
const maybe = await db.maybeOne(query);
const result = await db.execute(command);
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

## Packages

The workspace currently contains:

| Package | Responsibility |
| --- | --- |
| `@sqlbraid/core` | Public contracts and shared runtime types |
| `@sqlbraid/template` | Tagged templates, directives, rendering, structural helpers |
| `@sqlbraid/runtime` | Database execution, cardinality, transactions, prepared/streaming seams |
| `@sqlbraid/postgres` | PostgreSQL dialect, codecs, inspector, `pg` adapter |
| `@sqlbraid/mysql` | MySQL dialect, codecs, inspector, `mysql2` adapter |
| `@sqlbraid/sqlite` | SQLite dialect, inspector, `node:sqlite` adapter |
| `@sqlbraid/compiler` | TypeScript source discovery and guarded-template transform |
| `@sqlbraid/schema` | Metadata/snapshot structures used by tooling and verification |
| `@sqlbraid/operations` | Validation, fingerprints, operational metadata |
| `@sqlbraid/cli` | `sqlbraid` command-line tools |
| `@sqlbraid/language-server` | Editor/LSP integration |
| `@sqlbraid/ast` | Transitional lightweight SQL analysis; scope is being reduced |

See [`PLAN.md`](./PLAN.md) for the authoritative v1 scope and migration plan.

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

Published-package checks include packed external consumers, ESM/type resolution, subpath exports, CLI execution, `publint`, and Are The Types Wrong.

---

## Design principles

1. **SQL stays SQL.**
2. **Values are bound by default.**
3. **Dynamic SQL remains local and readable.**
4. **Explicit contracts beat fabricated inference.**
5. **The database is the authority for database semantics.**
6. **Unsupported analysis becomes `unknown`, not wishful typing.**
7. **Dialect adapters stay thin.**
8. **Plain objects in, plain objects out.**
9. **Offline development stays possible.**
10. **Complexity must earn its place in the product.**

---

## Roadmap

The immediate roadmap is intentionally focused:

1. simplify the codebase around explicit result contracts;
2. keep the dynamic SQL/template/runtime experience excellent;
3. finish ergonomic runtime validation;
4. build database-assisted query verification and manifests;
5. improve LSP/CLI workflows;
6. add operational runtime features such as pool leases and cancellation;
7. consider automatic inference only where metadata makes it cheap and trustworthy.

Full SQL semantic inference is not a release goal.

---

## Contributing

Read [`PLAN.md`](./PLAN.md) for product scope and [`AGENTS.md`](./AGENTS.md) for repository engineering rules before making broad architectural changes.

The most important contribution rule is simple: **do not grow SQLBraid into a partial database compiler unless the product cannot solve the problem more directly.**
