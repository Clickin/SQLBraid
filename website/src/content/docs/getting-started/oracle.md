---
title: Oracle quickstart
description: Connect SQLBraid to node-oracledb in Thin mode with explicit Oracle parameter hints.
---

Install the SQLBraid Oracle package and the driver together:

```bash
npm install @sqlbraid/oracle oracledb
```

The portable root does not import `oracledb`. The driver subpath owns the Node adapter:

```ts
import oracledb from "oracledb";
import { createOracledbDatabase } from "@sqlbraid/oracle/oracledb";
import { oracleParameter, sql } from "@sqlbraid/oracle";

interface UserRow {
  id: string;
  name: string;
}

const connection = await oracledb.getConnection({
  user: process.env.ORACLE_USER ?? "app",
  password: process.env.ORACLE_PASSWORD ?? "password",
  connectString: process.env.ORACLE_CONNECT_STRING ?? "localhost/FREEPDB1",
});
const db = createOracledbDatabase(connection);

try {
  const accountNumber = 1001;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id AS "id", name AS "name"
    FROM users
    WHERE account_number = ${sql.bind(accountNumber, oracleParameter.number())}
  `);
  console.log(users);
} finally {
  await connection.close();
}
```

`sql.bind` keeps the value separate from SQL text and supplies an Oracle database parameter type. Without a hint, the adapter uses its documented driver inference. SQLBraid never treats a TypeScript `number`, `string`, or `Date` as universal evidence for an Oracle type.

## Capability boundaries

- The first-party target is `node-oracledb` Thin mode. Thick mode is not an Official claim.
- `call()` is Unsupported in this RC because OUT/IN OUT descriptors are not yet part of the bind API.
- Streaming uses the driver's ResultSet protocol and closes the ResultSet on completion, abort, or early break.
- Local Node 22.18.0 tests use Oracle 23.9.0.25.07. Portable roots and the Thin adapter are conservatively Compatible until same-revision CI establishes Official coverage; see [runtime and driver support](/SQLBraid/reference/support/).

Use an explicit hint for `null` when the driver cannot infer a safe Oracle type. Do not silently turn an untyped null into `VARCHAR2`.

The default policy fetches `NUMBER` results as strings to preserve precision. Explicit `NUMBER` input accepts `number` or `bigint`; decimal strings are rejected by this adapter rather than converted lossily. Use an ordinary string bind with an explicit SQL conversion when your SQL requires decimal-text input.

The Thin adapter honors base type hints but rejects length/precision/scale facets: node-oracledb cannot express those constraints on an IN parameter. Put such constraints in SQL/schema; descriptors remain available to custom executors. Materialized CLOB/NCLOB values are strings and BLOB/RAW values are buffers; they do not retain a live LOB after lease release. Temporal values use `Date`, not a preserved source timezone name or sub-millisecond precision.
