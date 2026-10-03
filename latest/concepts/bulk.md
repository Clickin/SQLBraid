# Homogeneous bulk DML

> Execute one command shape with many value sets without hiding driver capabilities.

`db.bulk(inputs, factory)` is the SQLBraid throughput primitive for homogeneous
DML. It is different from `db.batch(queries)` on purpose. `db.batch(queries)`
executes a heterogeneous list of queries.

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

## Rules

- Bulk accepts only `CommandQuery` values. It does not return row sets. It does
  not work with DML `RETURNING`/`OUTPUT`.
- The first rendered statement sets one logical shape. Later rows must keep its
  Braid structure, list cardinality, hints and bind directions.
- Shape and materialization errors occur before database I/O. `sql.out()` and
  `sql.inOut()` are not valid bulk parameters.
- Empty input returns `{ inputCount: 0, affectedRows: 0 }`. It does not acquire a lease.
- The operation uses one physical lease. Drivers report the actual mode:
  `native-bulk`, `pipeline`, `prepared-loop` or `remote-batch`.
- Observers see one bulk operation, not N ordinary query lifecycles. The values
  of each item and the diagnostic SQL are available through the bulk
  description. The statement metadata is not copied N times.

## Atomicity and chunking

Root bulk has no portable transaction promise. SQLBraid never wraps it in a
transaction implicitly. If all changes must share a transaction, use a
transaction callback:

```ts
await db.tx(async (tx) => {
  await tx.bulk(inputs, factory);
});
```

There is no portable rule for automatic chunking. A driver can have stronger
native batch semantics. But applications must not depend on those semantics,
unless the documentation of the selected adapter describes them.

## Driver modes

| Adapter                     | Mode            | Structural evidence target                                                      |
| --------------------------- | --------------- | ------------------------------------------------------------------------------- |
| PostgreSQL / `pg`           | `prepared-loop` | sequential named execution; bounded per-client statement reuse                  |
| MySQL / `mysql2`            | `prepared-loop` | one prepare, N execute calls, `unprepare()` closes and evicts the cached handle |
| MariaDB / Connector/Node.js | `native-bulk`   | one `connection.batch()` call                                                   |
| SQLite / `node:sqlite`      | `prepared-loop` | one prepared statement reused                                                   |
| SQLite / `better-sqlite3`   | `prepared-loop` | one prepared statement reused                                                   |
| SQLite / libSQL             | `remote-batch`  | one `client.batch()` call                                                       |
| SQLite / WASM               | `prepared-loop` | one OO1 statement reset repeatedly                                              |
| Cloudflare D1               | `remote-batch`  | one `D1Database.batch()` call                                                   |
| Oracle Thin                 | `native-bulk`   | one `executeMany()` call                                                        |
| SQL Server / Tedious        | `prepared-loop` | one prepare/unprepare around N executes                                         |
| Bun.SQL                     | `prepared-loop` | one native execution for each input                                             |

For the profile and capability conditions of each revision, read [Runtime and driver support](/SQLBraid/latest/reference/support.md).
