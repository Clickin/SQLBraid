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
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";

const connection = await mysql.createConnection({
  uri: process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
});
const db = createMysql2Database(connection, { profile: MYSQL2_LOSSLESS_TEXT });

try {
  const rows = await db.all(sql.rows<{ id: string; name: string }>`
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
import { MYSQL2_LOSSLESS_TEXT, sql } from "@sqlbraid/mysql";

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL ?? "mysql://root:password@localhost/app",
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
});
const db = createMysql2PoolDatabase(pool, { profile: MYSQL2_LOSSLESS_TEXT });
const userId = 1;
try {
  const user = await db.maybeOne(sql.rows<{ id: string; name: string }>`
    SELECT id, name FROM users WHERE id = ${userId}
  `);
  console.log(user);
} finally {
  await pool.end();
}
```

The pool remains the application's resource. SQLBraid acquires and releases a physical connection for each independent root operation; `db.tx(...)` pins one lease for the callback.

Without a selected profile or policy, each lease derives its policy from the
observed connection; the pool does not claim a policy before acquisition.
An explicit descriptor stays authoritative: incompatible native results fail
rather than silently switching the runtime contract away from codegen.

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

This is an explicit configuration profile, not an implicit assumption.
`@sqlbraid/mysql` exports `typePolicyForProfile({ json, temporal })` and
immutable `representationProfiles`. The default `mysql2-lossless-text`
descriptor uses the fidelity-first options below; `mysql2-native` is a
separate convenience profile with native JSON/temporal results. Runtime and
codegen must select the same descriptor. The [runtime and driver support
matrix](/SQLBraid/reference/support/) records labels for the exact
database/driver/profile/runtime/capability tuple and its revision and workflow
evidence. A neighboring version or package installation is not certification.
Final exact-SHA Runtime, Docs, and Release gates and explicit release
authorization remain separate requirements.

| mysql2 option | `mysql2-lossless-text` | Effect |
| --- | --- | --- |
| `supportBigNumbers: true` | Required | Keeps large integer/decimal values out of lossy `number` inference. |
| `bigNumberStrings: true` | Required | Returns big-number values as strings for exact application handling. |
| `decimalNumbers: false` | Required | Avoids converting `DECIMAL` to JavaScript `number`; `true` is a different profile. |
| `rowsAsArray: false` | Required | Keeps object rows, which SQLBraid's normalizer and schemas expect. |
| `jsonStrings: true` | Required | Returns JSON text without `JSON.parse`; parsed JSON is a separate profile. |
| `dateStrings: true` | Required | Returns temporal text so fractional precision is visible; `Date` is a separate profile. |
| `typeCast` (default) | Required | A custom function changes raw representations and is a separate profile until tested. |

The effective profile records the mysql2 version, MySQL server, Node version,
and every option above. SQLBraid does not inspect a custom `typeCast` function
or infer its output. Driver raw values and SQLBraid canonical values are
separate facts. Integer and `DECIMAL` results are canonical
strings in the exact profile; use `decodeExactInteger`, `decodeExactDecimal`, or
an application-selected numeric transform at the application boundary. `FLOAT`
and `DOUBLE` remain JavaScript `number` (binary32/binary64). `insertId` is an
exact string where the driver exposes it; `affectedRows` is an operational count
with safe-range validation. Native MySQL SQL passes through transparently; this
does not mean SQLBraid parses every MySQL grammar feature.

Exact integer/decimal strings are the documented bind path for round-trip
fidelity through prepared and bulk execution. Ordinary `undefined` binds fail
with `BRAID_BIND_VALUE_UNSUPPORTED` before acquisition; `null` is SQL `NULL`.
Changing `decimalNumbers`, `jsonStrings`, `dateStrings`, or `typeCast` selects a
different profile and invalidates the evidence above until retested.

The binding transport is mysql2 text-positional `?` with ordered values.
Streaming uses prepared `Execute.stream()`. Routine result sets are
materialized by `db.call()`; prepared OUT/INOUT is unsupported. Bulk is a
prepared/native driver operation only when the selected adapter capability
and manifest prove it. Generic MySQL DML has no portable `RETURNING` clause,
so returned rows are not synthesized.
