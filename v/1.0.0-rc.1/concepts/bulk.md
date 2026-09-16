# Homogeneous bulk DML

> Execute one command shape with many value sets without hiding driver capabilities.

`db.bulk(inputs, factory)` is the SQLBraid throughput primitive for homogeneous
DML. It is deliberately different from `db.batch(queries)`, which executes a
heterogeneous list of queries.

```ts
const result = await db.bulk(
  accounts.map(({ id, amount }) => ({ id, amount })),
  (input) => sql.command`
    UPDATE account
    SET amount = ${input.amount}
    WHERE id = ${input.id}
  `,
);

// { inputCount, affectedRows? }
```

## Contract

- Only `CommandQuery` values are accepted. Bulk does not return row sets and
  does not combine with DML `RETURNING`/`OUTPUT`.
- The first rendered statement establishes one logical shape. Later rows must
  preserve its Braid structure, list/cardinality, hints, and bind directions.
- Shape or materialization errors happen before database I/O. `sql.out()` and
  `sql.inOut()` are not valid bulk parameters.
- Empty input returns `{ inputCount: 0 }` without acquiring a lease.
- One physical lease is used for the operation. Drivers report the actual mode:
  `native-bulk`, `pipeline`, `prepared-loop`, or `remote-batch`.
- Observers see one bulk operation, not N ordinary query lifecycles. Per-item
  values and diagnostic SQL are available through the bulk description without
  replicating statement metadata N times.

## Atomicity and chunking

Root bulk has no portable transaction promise and is never implicitly wrapped in
one. Use a transaction callback when all changes must share a transaction:

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, factory);
});
```

There is no portable auto-chunking contract. A driver may have stronger native
batch semantics, but applications must not depend on those semantics outside the
selected adapter's documentation.

## Driver modes

| Adapter | Mode | Structural evidence target |
| --- | --- | --- |
| PostgreSQL / `pg` | `prepared-loop` | sequential named execution; bounded per-client statement reuse |
| MySQL / `mysql2` | `prepared-loop` | one prepare, N execute calls, `unprepare()` closes and evicts the cached handle |
| MariaDB / Connector/Node.js | `native-bulk` | one `connection.batch()` call |
| SQLite / `node:sqlite` | `prepared-loop` | one prepared statement reused |
| SQLite / WASM | `prepared-loop` | one OO1 statement reset repeatedly |
| Cloudflare D1 | `remote-batch` | one `D1Database.batch()` call |
| Oracle Thin | `native-bulk` | one `executeMany()` call |
| SQL Server / Tedious | `prepared-loop` | one prepare/unprepare around N executes |

See [Runtime and driver support](/SQLBraid/v/1.0.0-rc.1/reference/support.md) for revision-specific profile and capability conditions.
