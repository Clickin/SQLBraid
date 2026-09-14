# @sqlbraid/mysql

MySQL SQL dialect, `mysql2` database adapters, routine result-set support, and metadata inspector for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

```ts
import { sql } from "@sqlbraid/mysql";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";

const db = createMysql2Database(connection);
const rows = await db.all(sql.rows<{ id: number }>`SELECT id FROM users WHERE id = ${1}`);
```

MySQL 8.4 has no generic PostgreSQL-style DML `RETURNING` clause. SQLBraid
does not rewrite MySQL writes or infer a substitute; use native MySQL syntax
and a separate query when the application needs returned rows.

MySQL row streaming uses the raw prepared `Execute.stream()` command behind the `mysql2/promise` connection; it does not downgrade to text `query()`. Configure `streamHighWaterMark` as needed. On break or abort, SQLBraid stops delivery and drains the protocol or discards the physical connection before lease release. An active signal destroys the driver's physical connection and discards that lease; adapters without a documented destroy primitive reject before I/O with `BRAID_CANCEL_UNSUPPORTED`.

`db.tx({ isolation, readOnly }, callback)` emits MySQL transaction control
statements on the pinned connection, preserving the selected isolation level
and read-only mode.
Malformed runtime values fail before acquisition as `TypeError` /
`BRAID_TX_OPTIONS_INVALID`; valid but unsupported options use
`BRAID_TX_OPTION_UNSUPPORTED`, and nested explicit options use
`BRAID_TX_OPTIONS_NESTED`.

The prepared CALL path currently rejects OUT/INOUT with `BRAID_CALL_OUT_UNSUPPORTED`: the real `mysql2` 3.x API does not expose a proven public discriminator for the protocol's extra OUT carrier result. SQLBraid does not guess which result set is the carrier. Emitted heterogeneous result sets remain available through `db.call()`; stored functions cannot emit result sets.

See the [MySQL setup](https://clickin.github.io/SQLBraid/getting-started/mysql/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).

## PV18 representation profiles

The exported `MYSQL2_LOSSLESS_TEXT` profile is the default SQLBraid
representation: `supportBigNumbers: true`, `bigNumberStrings: true`,
`decimalNumbers: false`, `rowsAsArray: false`, `jsonStrings: true`, and
`dateStrings: true`. Use its immutable options when creating a connection and
pass the descriptor to the adapter:

```ts
import mysql from "mysql2/promise";
import { MYSQL2_LOSSLESS_TEXT } from "@sqlbraid/mysql";
import { createMysql2Database } from "@sqlbraid/mysql/mysql2";

const connection = await mysql.createConnection({
  ...MYSQL2_LOSSLESS_TEXT.connectionOptions,
  uri,
});
const db = createMysql2Database(connection, { profile: MYSQL2_LOSSLESS_TEXT });
```

`representationProfiles` also exports `MYSQL2_NATIVE`,
`MYSQL2_JSON_TEXT`, and `MYSQL2_DATE_TEXT`. The adapter auto-recognizes
`mysql2`'s public connection configuration when available; pass the matching
descriptor when a wrapper does not expose it. All exact integer and decimal
results are canonical `string` values; FLOAT and DOUBLE remain JavaScript
`number` values. See the [data representation
guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).

JSON-text fidelity preserves the database's returned representation, not the
original JSON source: MySQL native JSON storage canonicalizes keys/whitespace
and can round decimal tokens. Store JSON in a text column when those original
digits must round-trip unchanged.
