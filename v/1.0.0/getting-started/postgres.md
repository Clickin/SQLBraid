# PostgreSQL quickstart

> Connect SQLBraid to pg with either a direct client or an explicit pool.

Install the SQLBraid runtime facade and the PostgreSQL driver together:

```bash
npm install sqlbraid pg
```

## Direct physical client

A direct factory receives a connected `pg.Client` or `pg.PoolClient`, not a `pg.Pool`:

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

See [direct connections and pools](/SQLBraid/v/1.0.0/runtime/direct-pools.md) and [transactions](/SQLBraid/v/1.0.0/runtime/transactions.md) for the boundary in detail.

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

The default `pg` profile is `pg-lossless-text`: JSON and temporal values
remain text where the driver can provide them. `@sqlbraid/postgres` exports
`typePolicyForProfile({ json, temporal })` and immutable
`representationProfiles` descriptors so runtime and codegen can reuse exactly
the same policy:

```ts
import { typePolicyForProfile } from "sqlbraid/pg";
import { generateModels } from "@sqlbraid/codegen";

const typePolicy = typePolicyForProfile({ json: "text", temporal: "text" });
const generated = generateModels(snapshot, { typePolicy });
```

`{ json: "native", temporal: "native" }` selects the separate
`pg-native` compatibility profile. Native means node-postgres's normal
per-OID parser behavior, not that every temporal type becomes `Date`. A custom
`pg-types` parser is another profile and needs its own raw-value evidence.

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

Exact string inputs are supported through the text-positional bind path when
the documented profile proves an end-to-end round trip. Ordinary `undefined`
binds fail with `BRAID_BIND_VALUE_UNSUPPORTED` before acquisition; `null` is SQL
`NULL`. Arrays, domains, ranges/multiranges and composites are unclassified
containers even when their scalar element types are exact.

`db.environment()` records `extra_float_digits`, the selected JSON/temporal
profile and TypePolicy provenance where available. It must not be read as an
unconditional fidelity guarantee. The [runtime and driver support
matrix](/SQLBraid/v/1.0.0/reference/support.md) records labels for the exact
database/driver/profile/runtime/capability tuple and its revision and workflow
evidence. A neighboring version or package installation is not certification.
Final exact-SHA Runtime, Docs, and Release gates and explicit release
authorization remain separate requirements.
`pg-cursor` supplies the native pull stream; a missing peer is
`BRAID_STREAM_UNSUPPORTED`. Routine refcursors require an existing transaction
and are materialized into result sets. Bulk uses the adapter's proven native
or prepared strategy, not a SQL rewrite. Native PostgreSQL SQL, including
`RETURNING`, passes through transparently; this is not PostgreSQL grammar
support by SQLBraid.
