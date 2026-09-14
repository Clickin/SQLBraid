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

MySQL row streaming uses the raw prepared `Execute.stream()` command behind the `mysql2/promise` connection; it does not downgrade to text `query()`. Configure `streamHighWaterMark` as needed. On break or abort, SQLBraid stops delivery and drains the protocol or discards the physical connection before lease release.

The prepared CALL path currently rejects OUT/INOUT with `BRAID_CALL_OUT_UNSUPPORTED`: the real `mysql2` 3.x API does not expose a proven public discriminator for the protocol's extra OUT carrier result. SQLBraid does not guess which result set is the carrier. Emitted heterogeneous result sets remain available through `db.call()`; stored functions cannot emit result sets.

See the [MySQL setup](https://clickin.github.io/SQLBraid/getting-started/mysql/), [streaming](https://clickin.github.io/SQLBraid/runtime/streaming/), and [routine guide](https://clickin.github.io/SQLBraid/concepts/routines/).

The exact mysql2 profile is explicit: `supportBigNumbers: true`,
`bigNumberStrings: true`, `decimalNumbers: false`, `rowsAsArray: false`,
`jsonStrings: false`, `dateStrings: false`, and the default `typeCast`.
Changing any option is a separate conditional profile until separately tested.
All exact integer and decimal results are canonical `string` values; FLOAT and
DOUBLE remain JavaScript `number` values. Set `jsonStrings: true` for the
lossless JSON-text profile and `dateStrings: true` for the lossless temporal
text profile, and pass matching `profile` evidence to the adapter when the
physical connection wrapper does not expose its options. See the [data
representation guide](https://clickin.github.io/SQLBraid/concepts/data-representation/).

JSON-text fidelity preserves the database's returned representation, not the
original JSON source: MySQL native JSON storage canonicalizes keys/whitespace
and can round decimal tokens. Store JSON in a text column when those original
digits must round-trip unchanged.
