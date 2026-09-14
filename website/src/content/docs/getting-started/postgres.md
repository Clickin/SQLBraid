---
title: PostgreSQL quickstart
description: Connect SQLBraid to pg with either a direct client or an explicit pool.
---

Install the SQLBraid PostgreSQL adapter and its driver together:

```bash
npm install @sqlbraid/postgres pg
```

## Direct physical client

A direct factory receives a connected `pg.Client` or `pg.PoolClient`, not a `pg.Pool`:

```ts
import { Client } from "pg";
import { createPgDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

interface UserRow { id: number; name: string }

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const db = createPgDatabase(client);

try {
  const users = await db.all<UserRow>(sql.rows<UserRow>`
    SELECT id, name FROM users ORDER BY id
  `);
  console.log(users);
} finally {
  await client.end();
}
```

## Pool-backed database

Use the pool factory when the application owns a `pg.Pool`:

```ts
import { Pool } from "pg";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";
import { sql } from "@sqlbraid/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);
const accountId = 1;

try {
  const account = await db.one(sql.rows<{ id: number; email: string }>`
    SELECT id, email FROM accounts WHERE id = ${accountId}
  `);
  console.log(account);
} finally {
  await pool.end();
}
```

A pooled root operation acquires one connection lease, performs its physical I/O, releases the lease, then maps materialized results. A transaction is the explicit connection-pinning boundary; use its callback handle for every operation inside it. The application owns pool shutdown.

The pg binding adapter receives a logical `RenderedStatement`, then materializes
text-positional `$1`, `$2`, … placeholders and the ordered value array. This
driver-owned step happens after pure binding description and before lease
acquisition; placeholder spelling is not supplied by the PostgreSQL dialect.
The adapter reports simple driver-owned reuse and rejects unsupported parameter
hints before I/O.

:::caution Do not pass a pool to `createPgDatabase`
SQLBraid does not duck-type pools. Passing `pg.Pool` to the direct factory is the wrong ownership model; use `createPgPoolDatabase(pool)`.
:::

See [direct connections and pools](/SQLBraid/runtime/direct-pools/) and [transactions](/SQLBraid/runtime/transactions/) for the boundary in detail.

## Streaming and routines

Install `pg-cursor` only when this application uses `db.stream()`:

```bash
npm install pg-cursor
```

The peer is optional for ordinary queries. PostgreSQL streaming uses cursor
batch reads and reports `BRAID_STREAM_UNSUPPORTED` if the capability is absent.
Abort awaits physical `Client.end()` and discards the connection, including a
pending batch read. Pools replace that connection; direct clients must be
replaced. Custom wrappers need to expose `end()` for abortable streams.
For a routine with a `refcursor` OUT/INOUT parameter, use
`postgresParameter.refcursor()` and call it inside an existing
`db.tx(async (tx) => tx.call(query))` scope. SQLBraid fetches and closes the
transaction-bound portal, removes it from scalar `output`, and returns its rows
in `resultSets`; it never creates a hidden transaction.

## pg representation profile

The profile is `pg`'s default parser set on the exact database/runtime
combination recorded by the support manifest. A custom `pg-types` parser is a
different, conditional profile and must have its own raw-value evidence.

| Value | Default profile representation | Boundary |
| --- | --- | --- |
| `int8` | string | Use `decodeExactInteger` when the application needs `bigint`. |
| `numeric`/`decimal` | string | Keep text or pass through an application decimal library; do not coerce to `number`. |
| `json`/`jsonb` | parsed JavaScript value | Validate with Standard Schema; a custom parser may instead return text. |
| `bytea` | `Buffer` | Keep bytes or explicitly encode them. |
| `uuid` | string | Validate format in the application schema when needed. |
| date/time | JavaScript `Date` or driver text for configured variants | `Date` does not preserve every source offset/precision detail. |

The binding transport is text-positional `$1`, `$2`, … with ordered values.
`pg-cursor` supplies the native pull stream; a missing peer is
`BRAID_STREAM_UNSUPPORTED`. Routine refcursors require an existing transaction
and are materialized into result sets. Bulk uses the adapter's proven native
or prepared strategy, not a SQL rewrite. Native PostgreSQL SQL, including
`RETURNING`, passes through transparently; this is not PostgreSQL grammar
support by SQLBraid.
