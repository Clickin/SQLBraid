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

:::caution Do not pass a pool to `createPgDatabase`
SQLBraid does not duck-type pools. Passing `pg.Pool` to the direct factory is the wrong ownership model; use `createPgPoolDatabase(pool)`.
:::

See [direct connections and pools](/SQLBraid/runtime/direct-pools/) and [transactions](/SQLBraid/runtime/transactions/) for the boundary in detail.
