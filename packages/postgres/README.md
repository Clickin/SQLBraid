# @sqlbraid/postgres

PostgreSQL SQL dialect, `pg` database adapters, routine support, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
# Add pg-cursor only when db.stream() is needed:
npm install pg-cursor
```

```ts
import { sql } from "@sqlbraid/postgres";
import { createPgDatabase } from "@sqlbraid/postgres/pg";

const db = createPgDatabase(client);
const rows = await db.all(sql.rows<{ id: number }>`SELECT id FROM users WHERE id = ${1}`);
```

PostgreSQL DML `RETURNING` is a row-producing statement: use
`db.execute`, `db.all`, `db.one`, or `db.maybeOne` with `sql.rows`. PV16
documents materialized DML-returning only; `db.stream()` cancellation and
rollback behavior is not a portable returning contract.

`pg-cursor` is an optional peer. PostgreSQL row streaming uses its cursor protocol and fails with `BRAID_STREAM_UNSUPPORTED` when that peer/capability is unavailable; ordinary queries do not require it. Configure `streamBatchSize` or an explicit cursor factory when needed.

Exhaustion, break and mapper failure close the cursor before lease release.
Abort uses the physical client's public `end()` method because closing a portal
cannot interrupt a pending Execute. SQLBraid awaits termination and discards
that lease; a pool supplies a replacement connection, while a direct client must
be replaced. An abortable custom client wrapper must expose `end()`.

Routine calls support scalar OUT/INOUT values. Mark PostgreSQL `refcursor` OUT/INOUT parameters with `postgresParameter.refcursor()`; they become materialized `resultSets`, are removed from scalar `output`, and are fetched/closed on the same physical connection. A refcursor call requires an existing `db.tx(...)` scope because the portal is transaction-bound; SQLBraid does not create a hidden transaction.

Logical `outputName` values rename positional CALL outputs; they do not select
carrier columns by database field name.

See the [PostgreSQL setup](https://clickin.github.io/SQLBraid/getting-started/postgres/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).

Representation profile: the default `pg` parser returns `int8` and
`numeric`/`decimal` as strings, `json`/`jsonb` as parsed values, `bytea` as
`Buffer`, and UUIDs as strings. Custom parsers are separate conditional
profiles and need their own evidence. See the [data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
