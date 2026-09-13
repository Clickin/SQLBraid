---
title: MySQL quickstart
description: Connect SQLBraid to mysql2 with either a direct connection or an explicit pool.
---

Install the SQLBraid MySQL adapter and its driver together:

```bash
npm install @sqlbraid/mysql mysql2
```

## Direct physical connection

The direct factory receives a connected `Connection` or `PoolConnection` object from `mysql2/promise`, not an unresolved Promise or a pool:

```ts
import mysql from "mysql2/promise";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

const connection = await mysql.createConnection(
  process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
);
const db = createMysql2Database(connection);

try {
  const rows = await db.all(sql.rows<{ id: number; name: string }>`
    SELECT id, name FROM users ORDER BY id
  `);
  console.log(rows);
} finally {
  await connection.end();
}
```

## Pool-backed database

Use the pool factory for `mysql2/promise` pools:

```ts
import mysql from "mysql2/promise";
import { createMysql2PoolDatabase } from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

const pool = mysql.createPool(process.env.DATABASE_URL ?? "mysql://root:password@localhost/app");
const db = createMysql2PoolDatabase(pool);
const userId = 1;
try {
  const user = await db.maybeOne(sql.rows<{ id: number; name: string }>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(user);
} finally {
  await pool.end();
}
```

The pool remains the application's resource. SQLBraid acquires and releases a physical connection for each independent root operation; `db.tx(...)` pins one lease for the callback.

The mysql2 binding adapter materializes the logical statement as text-positional
`?` placeholders plus the ordered value array. Binding description and hint
validation happen before acquisition; mysql2 owns effective reuse, including
the requested `reuse` policy. Unsupported hints fail before driver I/O.

:::caution Do not pass a pool to `createMysql2Database`
Use `createMysql2PoolDatabase(pool)` for a pool. Explicit factories keep transaction and release semantics physical-connection-safe.
:::

## Streaming and routine boundaries

`db.stream()` uses the raw prepared `Execute.stream()` command behind the
promise connection. It preserves prepared/binary execution; it does not
downgrade to text `query()`. On break or abort SQLBraid stops row delivery and
drains the command or discards the physical connection before releasing it.

MySQL emitted result sets may be heterogeneous:

```ts
const result = await db.call(sql.call({
  resultSets: [UserSchema, SummarySchema] as const,
})`CALL dashboard()`);
```

Prepared CALL OUT/INOUT is currently rejected with
`BRAID_CALL_OUT_UNSUPPORTED`. mysql2 3.x exposes no proven public discriminator
for the protocol's extra OUT carrier result, so SQLBraid does not guess a
carrier row. Stored functions cannot emit result sets.
