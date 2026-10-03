# MySQL quickstart

> Connect SQLBraid to mysql2 with either a direct connection or an explicit pool.

Install the SQLBraid runtime facade and the MySQL driver together:

```bash
npm install sqlbraid mysql2
```

## Direct physical connection

The direct factory accepts a connected `Connection` or `PoolConnection` object from `mysql2/promise`. It does not accept an unresolved Promise or a pool:

```ts
import mysql from "mysql2/promise";
import { createMysql2Database, MYSQL2_LOSSLESS_TEXT, sql } from "sqlbraid/mysql2";

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
import { createMysql2PoolDatabase, MYSQL2_LOSSLESS_TEXT, sql } from "sqlbraid/mysql2";

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

The pool stays a resource of the application. SQLBraid acquires and releases a physical connection for each independent root operation. `db.tx(...)` pins one lease for the callback.

If you do not select a profile or a policy, each lease gets its policy from the
observed connection. The pool does not claim a policy before acquisition. An
explicit descriptor stays the authority. Incompatible native results fail.
SQLBraid does not silently change the runtime rules away from codegen.

The mysql2 binding adapter materializes the logical statement as text-positional
`?` placeholders and the ordered value array. The binding description and the
hint validation occur before acquisition. mysql2 owns the effective reuse,
including the requested `reuse` policy. Unsupported hints fail before driver I/O.

:::caution Do not pass a pool to `createMysql2Database`
For a pool, use `createMysql2PoolDatabase(pool)`. Explicit factories keep the transaction and release semantics safe for physical connections.
:::

## Streaming and routine boundaries

`db.stream()` uses the raw prepared `Execute.stream()` command behind the
promise connection. It keeps prepared, binary execution. It does not change to
the text `query()`. On a break or an abort, SQLBraid stops the delivery of rows.
Then it drains the command, or it discards the physical connection, before it
releases the connection.

MySQL emitted result sets can be heterogeneous:

```ts
const result = await db.call(
  sql.call({
    resultSets: [UserSchema, SummarySchema] as const,
  })`CALL dashboard()`,
);
```

Prepared CALL OUT and INOUT are currently rejected with
`BRAID_CALL_OUT_UNSUPPORTED`. mysql2 3.x has no proven public discriminator for
the extra OUT carrier result of the protocol. Thus, SQLBraid does not guess a
carrier row. Stored functions cannot emit result sets.

## mysql2 representation profile

This is an explicit configuration profile. It is not an implicit assumption.

- `@sqlbraid/mysql` exports `typePolicyForProfile({ json, temporal })` and
  immutable `representationProfiles`.
- The default `mysql2-lossless-text` descriptor uses the fidelity-first options
  below.
- `mysql2-native` is a separate convenience profile with native JSON and
  temporal results.
- The runtime and codegen must select the same descriptor.

The [runtime and driver support matrix](/SQLBraid/latest/reference/support.md) records
labels for each exact tuple of database, driver, profile, runtime and
capability, with its revision and workflow evidence. A neighboring version or a
package installation is not certification. The final exact-SHA Runtime, Docs
and Release gates and an explicit release authorization stay separate
requirements.

| mysql2 option             | `mysql2-lossless-text` | Effect                                                                                  |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `supportBigNumbers: true` | Required               | Keeps large integer/decimal values out of lossy `number` inference.                     |
| `bigNumberStrings: true`  | Required               | Returns big-number values as strings for exact application handling.                    |
| `decimalNumbers: false`   | Required               | Avoids converting `DECIMAL` to JavaScript `number`; `true` is a different profile.      |
| `rowsAsArray: false`      | Required               | Keeps object rows, which SQLBraid's normalizer and schemas expect.                      |
| `jsonStrings: true`       | Required               | Returns JSON text without `JSON.parse`; parsed JSON is a separate profile.              |
| `dateStrings: true`       | Required               | Returns temporal text so fractional precision is visible; `Date` is a separate profile. |
| `typeCast` (default)      | Required               | A custom function changes raw representations and is a separate profile until tested.   |

The effective profile records the mysql2 version, the MySQL server, the Node
version and each option above. SQLBraid does not inspect a custom `typeCast`
function or infer its output. Raw driver values and canonical SQLBraid values are
separate facts.

- In the exact profile, integer and `DECIMAL` results are canonical strings. At
  the application boundary, use `decodeExactInteger`, `decodeExactDecimal` or a
  numeric transform that the application selects.
- `FLOAT` and `DOUBLE` stay JavaScript `number` (binary32/binary64).
- `insertId` is an exact string where the driver exposes it.
- `affectedRows` is an operational count with safe-range validation.
- Native MySQL SQL passes through without change. This does not mean that
  SQLBraid parses each MySQL grammar feature.

Exact integer and decimal strings are the documented bind path for round-trip
fidelity through prepared and bulk execution. Ordinary `undefined` binds fail
with `BRAID_BIND_VALUE_UNSUPPORTED` before acquisition. `null` is SQL `NULL`.
If you change `decimalNumbers`, `jsonStrings`, `dateStrings` or `typeCast`, you
select a different profile. The evidence above is then not valid until it is
tested again.

- The binding transport is mysql2 text-positional `?` with ordered values.
- Streaming uses prepared `Execute.stream()`.
- `db.call()` materializes routine result sets. Prepared OUT and INOUT are
  unsupported.
- Bulk is a prepared or native driver operation only when the capability and
  manifest of the selected adapter prove it.
- Generic MySQL DML has no portable `RETURNING` clause. Thus, SQLBraid does not
  synthesize returned rows.
