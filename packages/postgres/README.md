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

`pg-cursor` is an optional peer. PostgreSQL row streaming uses its cursor protocol and fails with `BRAID_STREAM_UNSUPPORTED` when that peer/capability is unavailable; ordinary queries do not require it. Configure `streamBatchSize` or an explicit cursor factory when needed. An active signal uses the driver's physical cancellation path; a driver without that path must reject before I/O with `BRAID_CANCEL_UNSUPPORTED`.

Exhaustion, break and mapper failure close the cursor before lease release.
Abort uses the physical client's public `end()` method because closing a portal
cannot interrupt a pending Execute. SQLBraid awaits termination and discards
that lease; a pool supplies a replacement connection, while a direct client must
be replaced. An abortable custom client wrapper must expose `end()`.

`db.tx({ isolation, readOnly }, callback)` emits PostgreSQL transaction modes
on the pinned client. `read-uncommitted` is guarded because PostgreSQL maps it
to `read-committed`.
Malformed runtime values fail before acquisition as `TypeError` /
`BRAID_TX_OPTIONS_INVALID`; valid but unsupported options use
`BRAID_TX_OPTION_UNSUPPORTED`, and nested explicit options use
`BRAID_TX_OPTIONS_NESTED`.

Routine calls support scalar OUT values. INOUT and return-value carriers are
rejected with `BRAID_CALL_OUT_UNSUPPORTED` because `pg` does not expose a
verified portable carrier contract. Mark PostgreSQL `refcursor` OUT parameters
with `postgresParameter.refcursor()`; they become materialized `resultSets`,
are removed from scalar `output`, and are fetched/closed on the same physical
connection. A refcursor call requires an existing `db.tx(...)` scope because
the portal is transaction-bound; SQLBraid does not create a hidden
transaction.

Logical `outputName` values rename positional CALL outputs; they do not select
carrier columns by database field name.

See the [PostgreSQL setup](https://clickin.github.io/SQLBraid/getting-started/postgres/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).

Representation profiles are reusable runtime/codegen contracts. The default
`pg-lossless-text` profile uses query-local public parser overrides,
returning exact numerics and JSON/temporal values as text, approximate floats
as JavaScript `number`, `bytea` as `Uint8Array` (node-postgres supplies a
`Buffer`), and UUIDs as strings. The `pg-native` profile delegates JSON
and temporal values to node-postgres: JSON roots are `unknown`, date and
timestamp families are `Date`, time families are strings, and interval output
is `unknown`.

Use `typePolicyForProfile({ json: "text" | "native", temporal: "text" | "native" })`
or select a descriptor from `representationProfiles` so runtime and codegen
use the same policy. `parserProfile: { json: "native", temporal: "native" }`
selects the native profile.
Custom parsers are separate conditional profiles and need their own evidence.
PostgreSQL `money` is unsupported by the exact output profile because its
textual form is locale-sensitive; use an explicit native numeric cast when
exact text is required. PostgreSQL arrays, domains, ranges/multiranges, and
composites are not recursively normalized: lossless text exposes common
containers as one raw PostgreSQL text value, while native containers remain
driver-defined `unknown`. See the [data representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).
