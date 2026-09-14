---
title: SQL Server quickstart
description: Connect SQLBraid to Tedious with deterministic SQL Server parameter hints.
---

Install the SQLBraid SQL Server package and Tedious together:

```bash
npm install @sqlbraid/mssql tedious
```

The portable root exposes the SQL Server dialect and hint factories. The Node driver adapter is under `/tedious`:

```ts
import { Connection } from "tedious";
import { createTediousDatabase } from "@sqlbraid/mssql/tedious";
import { mssqlParameter, sql } from "@sqlbraid/mssql";

interface UserRow {
  id: number;
  name: string;
}

const connection = new Connection({
  server: process.env.SQLSERVER_HOST ?? "localhost",
  authentication: {
    type: "default",
    options: {
      userName: process.env.SQLSERVER_USER ?? "sa",
      password: process.env.SQLSERVER_PASSWORD ?? "Password!123",
    },
  },
  options: { database: process.env.SQLSERVER_DATABASE ?? "app", trustServerCertificate: true },
});
await new Promise<void>((resolve, reject) => {
  connection.once("connect", (error) => error ? reject(error) : resolve());
  connection.connect();
});
const db = createTediousDatabase(connection);

try {
  const name = "Ada";
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name
    FROM users
    WHERE name = ${sql.bind(name, mssqlParameter.nvarchar(200))}
  `);
  console.log(users);
} finally {
  connection.close();
}
```

Tedious receives deterministic `@p1`, `@p2`, ... parameter names. `sql.bind` selects the database type; it does not turn the value into SQL text. Scalar OUTPUT/INOUT routine parameters require explicit hints. A T-SQL integer RETURN status requires explicit `procedure: { name, parameterNames }` metadata in the `sql.call` contract; SQLBraid does not parse arbitrary `EXEC` text to guess identity.

The Tedious binding adapter materializes a logical statement as a typed request:
deterministic `@p1`, `@p2`, … names, `TYPES.*` mappings, encoded values, and
facets. Description, hint validation, and exactness checks happen before lease
acquisition. Tedious owns effective reuse; failures in this work are
`materialize` errors with no driver I/O.

## Capability boundaries

- The target combination is Tedious on Node 22.18.0/Linux x64. PV15 final
  verification is pending; do not treat the historical matrix as a current
  release-gate result.
- Historical fixtures use SQL Server 2022 CU18 (16.0.4185.3), Linux x64;
  local ARM emulation is outside this guide's verification scope.
- Unhinted common values use adapter-local Tedious inference. Use an explicit hint for `null`, custom objects, precision/scale, lengths, or SQL Server-specific types.
- The adapter preserves multiple recordsets instead of flattening them into fabricated single-row results.
- `CURSOR VARYING OUTPUT` is not an application cursor channel and is rejected with `BRAID_CALL_CURSOR_UNSUPPORTED`. Batches that consume a local cursor and emit `SELECT` rows return those rows as ordinary result sets.

Tedious returns `decimal`/`numeric` as JavaScript numbers; this default policy does not promise arbitrary-precision decimal results. Explicit decimal-text inputs exceeding 15 significant digits are rejected with `BRAID_BIND_DECIMAL_EXACTNESS`. For exact decimal text, select an explicit SQL string conversion and declare a string result contract. `bigint` results use strings. Date/time values use `Date`, which does not preserve the original offset or sub-millisecond precision.

See [runtime and driver support](/SQLBraid/reference/support/) for the evidence labels and current matrix.

For the explicit procedure metadata shape and heterogeneous `sql.call` result
contract, see [routine calls](/SQLBraid/concepts/routines/).

## Tedious representation profile

The documented free test target is SQL Server Developer/Express-compatible
testing with Tedious on Node 22.18.0/Linux x64. The support manifest, not this
page, assigns the evidence label; another SQL Server edition or runtime is a
separate profile.

| SQL Server value | Tedious representation | Status/caveat |
| --- | --- | --- |
| `bigint` | string | Preserve text or use `decodeExactInteger`; do not coerce blindly. |
| `decimal` / `numeric` | JavaScript `number` | **Exact decimal unsupported** in this profile; convert to text in authored SQL when needed. |
| `datetime2` / `datetimeoffset` | `Date` | Offset name and sub-millisecond detail are not preserved. |
| `uniqueidentifier` | string | Validate with the application schema if required. |
| `varbinary` | `Buffer` | Keep bytes or explicitly encode. |
| JSON | text | Parse and validate with Standard Schema; SQL Server JSON functions do not change this boundary. |

The binding transport is a typed Tedious request with deterministic `@p1`,
`@p2`, … names and `TYPES.*` metadata. Native `OUTPUT` rows are materialized
through `sql.rows`; output/return routine channels use explicit metadata.
Prepared-loop is the portable bulk strategy. Native SQL passes through
transparently, while SQLBraid does not claim to parse all T-SQL grammar.
