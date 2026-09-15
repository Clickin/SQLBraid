# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
# Install this optional peer only when db.stream() is needed:
npm install pg-cursor
```

The application creates and connects the `pg` client or pool.

```ts
import { Client } from "pg";
import { sql } from "@sqlbraid/postgres";
import { createPgDatabase } from "@sqlbraid/postgres/pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const db = createPgDatabase(client);
const rows = await db.all(sql.rows<{ id: string }>`
  SELECT CAST(1 AS bigint) AS id
`);
// rows[0].id is the exact decimal string "1"
```

Use `createPgPoolDatabase(pool)` from `@sqlbraid/postgres/pg` for a connected
pool. The direct and pool factories accept the same optional representation
profile and type-policy options.

## Default result representations

The default `pg-lossless-text` policy keeps exact values usable without
JavaScript numeric rounding:

- `smallint`, `integer`, `bigint`, and `oid` are decimal `string` values.
- `numeric` and `decimal` are decimal `string` values.
- `real`/`float4` and `double precision`/`float8` are JavaScript `number`
  values.
- JSON and JSONB, date/time/interval values, and PostgreSQL arrays are text
  strings. `bytea` is a `Uint8Array` (node-postgres supplies a `Buffer`), and
  UUIDs are strings.

Select `representationProfiles`, `typePolicyForProfile`, or
`parserProfile: { json: "native", temporal: "native" }` when application
code intentionally wants node-postgres native JSON and temporal values. Keep
the selected policy consistent with generated types. PostgreSQL `money` is
locale-formatted and is not treated as an exact decimal; cast it explicitly in
SQL when exact text is required.

`sql.rows` with PostgreSQL `RETURNING` uses the normal materialized row APIs.
`db.stream()` uses the optional `pg-cursor` protocol and returns rows in
batches; it is unavailable without that peer. A cancellation signal uses the
client's physical cancellation path, and an aborted direct client must be
replaced after cancellation. Pool connections are discarded and replaced by
the pool.

Routine calls can map scalar OUT values. Mark a PostgreSQL `refcursor` OUT
parameter with the exported `postgresParameter.refcursor()`; SQLBraid fetches
it into materialized `resultSets` on the same connection. A refcursor call must
run inside an existing `db.tx()` because PostgreSQL portals are
transaction-bound. PostgreSQL return-value carriers and INOUT mappings are not
claimed by this adapter.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/),
[PostgreSQL setup](https://clickin.github.io/SQLBraid/getting-started/postgres/),
and [data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
