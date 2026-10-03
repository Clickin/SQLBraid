---
title: PostgreSQL quickstart
description: Connect SQLBraid to pg with either a direct client or an explicit pool.
---

Install the SQLBraid runtime facade and the PostgreSQL driver together:

```bash
npm install sqlbraid pg
```

## Direct physical client

A direct factory accepts a connected `pg.Client` or `pg.PoolClient`. It does not accept a `pg.Pool`:

```ts
import { Client } from "pg";
import { createPgDatabase, sql } from "sqlbraid/pg";

interface UserRow {
  id: string;
  name: string;
}

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
import { createPgPoolDatabase, sql } from "sqlbraid/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = createPgPoolDatabase(pool);
const accountId = 1;

try {
  const account = await db.one(sql.rows<{ id: string; email: string }>`
    SELECT id, email FROM accounts WHERE id = ${accountId}
  `);
  console.log(account);
} finally {
  await pool.end();
}
```

A pooled root operation does these steps: it acquires one connection lease, does its physical I/O, releases the lease and then maps the materialized results. A transaction is the explicit boundary that pins a connection. Inside a transaction, use its callback handle for each operation. The application owns the shutdown of the pool.

The pg binding adapter receives a logical `RenderedStatement`. Then it
materializes text-positional `$1`, `$2`, … placeholders and the ordered value
array. The driver owns this step. It occurs after the pure binding description
and before lease acquisition. The PostgreSQL dialect does not supply the
placeholder spelling. The adapter reports simple reuse that the driver owns. It
rejects unsupported parameter hints before I/O.

:::caution Do not pass a pool to `createPgDatabase`
SQLBraid does not duck-type pools. If you pass `pg.Pool` to the direct factory, the ownership model is wrong. Use `createPgPoolDatabase(pool)`.
:::

For the details of this boundary, read [direct connections and pools](/SQLBraid/runtime/direct-pools/) and [transactions](/SQLBraid/runtime/transactions/).

## Streaming and routines

Install `pg-cursor` only if this application uses `db.stream()`:

```bash
npm install pg-cursor
```

Ordinary queries do not need this peer.

- PostgreSQL streaming uses cursor batch reads. If the capability is absent, it
  reports `BRAID_STREAM_UNSUPPORTED`.
- An abort waits for the physical `Client.end()` and discards the connection.
  This includes a pending batch read.
- Pools replace that connection. You must replace a direct client.
- For abortable streams, custom wrappers must expose `end()`.

For a routine with a `refcursor` OUT or INOUT parameter, use
`postgresParameter.refcursor()`. Call the routine inside an existing
`db.tx(async (tx) => tx.call(query))` scope. SQLBraid fetches and closes the
portal of the transaction. It removes the portal from the scalar `output` and
returns its rows in `resultSets`. It never creates a hidden transaction.

## pg representation profile

The default `pg` profile is `pg-lossless-text`. JSON and temporal values stay
text where the driver can supply text. `@sqlbraid/postgres` exports
`typePolicyForProfile({ json, temporal })` and immutable
`representationProfiles` descriptors. Thus, the runtime and codegen can use
exactly the same policy:

```ts
import { typePolicyForProfile } from "sqlbraid/pg";
import { generateModels } from "@sqlbraid/codegen";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy });
```

`{ json: "native", temporal: "native" }` selects the separate `pg-native`
compatibility profile. Native means the normal per-OID parser behavior of
node-postgres. It does not mean that each temporal type becomes `Date`. A custom
`pg-types` parser is another profile. It needs its own raw-value evidence.

| Value                                | Driver raw / SQLBraid canonical output | Fidelity boundary                                                                                                        |
| ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `int2` / `int4` / `int8` / `oid`     | driver-dependent → `string`            | Exact output is canonical text, never `number` or `bigint`.                                                              |
| `numeric` / `decimal`                | text → `string`                        | A JavaScript `number` is not accepted as exact.                                                                          |
| `float4` / `float8`                  | number → `number`                      | Approximate binary value; `SHOW extra_float_digits` must be positive for the lossless text read profile.                 |
| `money`                              | unsupported                            | PostgreSQL's locale-formatted text is not a canonical numeric value; use an authored conversion with an explicit format. |
| `json` / `jsonb`                     | text → `string`; native → `unknown`    | Parsed roots may be string, number, boolean, `null`, array, or object; native nested numeric fidelity is not guaranteed. |
| `date` / `timestamp` / `timestamptz` | text → `string`; native → `Date`       | `time`/`timetz` remain text in native mode; `interval` is `unknown`.                                                     |
| `bytea`                              | `Buffer`                               | Keep bytes or explicitly encode them.                                                                                    |
| `uuid`                               | string                                 | Validate format in the application schema when needed.                                                                   |

- Exact string inputs are supported through the text-positional bind path, when
  the documented profile proves a full round trip.
- Ordinary `undefined` binds fail with `BRAID_BIND_VALUE_UNSUPPORTED` before
  acquisition. `null` is SQL `NULL`.
- Arrays, domains, ranges, multiranges and composites are unclassified
  containers. This is also true when their scalar element types are exact.

`db.environment()` reports the selected profile (for example,
`pg-lossless-text`) and the id and hash of the TypePolicy. It reads the server
setting `extra_float_digits`, but it does not report the value. If the value is
greater than 0, `numeric.approximate-float` is `guaranteed`. If not, it is
`guarded` with the condition `pg.extra-float-digits`. Do not read the report as
an unconditional fidelity guarantee. The [runtime and driver support
matrix](/SQLBraid/reference/support/) records labels for each exact tuple of
database, driver, profile, runtime and capability, with its revision and
workflow evidence. A neighboring version or a package installation is not
certification. The final exact-SHA Runtime, Docs and Release gates and an
explicit release authorization stay separate requirements.

- `pg-cursor` supplies the native pull stream. A missing peer gives
  `BRAID_STREAM_UNSUPPORTED`.
- Routine refcursors require an existing transaction. They are materialized into
  result sets.
- Bulk uses the proven native or prepared strategy of the adapter. It does not
  rewrite SQL.
- Native PostgreSQL SQL, including `RETURNING`, passes through without change.
  This does not mean that SQLBraid supports the PostgreSQL grammar.
