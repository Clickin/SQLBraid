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

## mysql2 representation profile

This is a configuration profile, not an implicit assumption. The support
manifest owns the evidence label; until the exact final-SHA matrix is green,
treat this profile as pending/conditional rather than an Official claim.

| mysql2 option | Exact-profile classification | Effect |
| --- | --- | --- |
| `supportBigNumbers: true` | Official profile requirement | Keeps large integer/decimal values out of lossy `number` inference. |
| `bigNumberStrings: true` | Official profile requirement | Returns big-number values as strings for exact application handling. |
| `decimalNumbers: false` | Official profile requirement | Avoids converting `DECIMAL` to JavaScript `number`. `true` is lossy/conditional. |
| `rowsAsArray: false` | Official profile requirement | Keeps object rows, which SQLBraid's normalizer and schemas expect. |
| `jsonStrings: false` | Conditional | Native parsed JSON is expected; `true` requires a text schema/parser profile. |
| `dateStrings: false` | Conditional | `Date` values are expected; `true` is a separate text-temporal profile. |
| `typeCast` (default) | Official profile requirement | A custom function changes raw representations and is conditional until separately tested. |

The exact tested combination must record the mysql2 version, MySQL/MariaDB
server, Node version, and every option above. SQLBraid does not inspect a
custom `typeCast` function or infer its output. `DECIMAL` is a string in the
exact profile; use `decodeExactDecimal` or an application-selected decimal
library. `BIGINT` is also handled as exact text rather than coerced to
`number`. Native MySQL SQL passes through transparently; this does not mean
SQLBraid parses every MySQL grammar feature.

The binding transport is mysql2 text-positional `?` with ordered values.
Streaming uses prepared `Execute.stream()`. Routine result sets are
materialized by `db.call()`; prepared OUT/INOUT is unsupported. Bulk is a
prepared/native driver operation only when the selected adapter capability
and manifest prove it. Generic MySQL DML has no portable `RETURNING` clause,
so returned rows are not synthesized.
