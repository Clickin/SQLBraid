# SQL Server quickstart

> Connect SQLBraid to Tedious with deterministic SQL Server parameter hints.

Install the SQLBraid runtime facade and Tedious together:

```bash
npm install sqlbraid tedious
```

The portable root exposes the SQL Server dialect and hint factories. The Node driver adapter is under `/tedious`:

```ts
import { Connection } from "tedious";
import { createTediousDatabase, mssqlParameter, sql } from "sqlbraid/tedious";

interface UserRow {
  id: string;
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

- The documented candidate is Tedious 20.0.0 on Node 22.18.0/Linux x64. The
  [runtime and driver support matrix](/SQLBraid/v/1.0.0-rc.2/reference/support.md) records
  labels for the exact database/driver/profile/runtime/capability tuple and its
  revision and workflow evidence. A neighboring version or package installation
  is not certification. Final exact-SHA Runtime, Docs, and Release gates and
  explicit release authorization remain separate requirements.
- The target uses SQL Server 2022 CU18 Developer, Linux x64;
  local ARM emulation is outside this guide's verification scope.
- Unhinted common values use adapter-local Tedious inference. Use an explicit hint for `null`, custom objects, precision/scale, lengths, or SQL Server-specific types.
- The adapter preserves multiple recordsets instead of flattening them into fabricated single-row results.
- `CURSOR VARYING OUTPUT` is not an application cursor channel and is rejected with `BRAID_CALL_CURSOR_UNSUPPORTED`. Batches that consume a local cursor and emit `SELECT` rows return those rows as ordinary result sets.

Tedious exposes `decimal`/`numeric`, `money`, and `smallmoney` through
JavaScript `number`; SQLBraid therefore fails closed with
`BRAID_RESULT_EXACTNESS` instead of stringifying a lossy exact value. Tedious
`BIGINT` text is normalized to the canonical exact string. For exact decimal or
money results, author a text expression such as
`CONVERT(varchar(100), exact_column)` with an appropriate length and
declare a string result contract. For exact input, use a character hint
(`mssqlParameter.nvarchar(...)`) and let authored SQL choose conversion, for
example `CAST(@nvarchar_parameter AS decimal(38, 18))`; the native typed
DECIMAL/NUMERIC/MONEY convenience path is bounded JavaScript `number` input,
not arbitrary-precision fidelity. Native temporal values use `Date`, which
does not preserve SQL Server's 100ns precision or complete offset semantics;
author `CONVERT(varchar(...), datetime2_or_datetimeoffset, style)` when exact
temporal text matters.

For the explicit procedure metadata shape and heterogeneous `sql.call` result
contract, see [routine calls](/SQLBraid/v/1.0.0-rc.2/concepts/routines.md).

## Tedious representation profile

The documented free test target is SQL Server 2022 CU18 Developer with
Tedious 20.0.0 on Node 22.18.0/Linux x64. The support manifest, not this
page, assigns the evidence label; another SQL Server edition or runtime is a
separate profile.

| SQL Server value | Driver raw / SQLBraid canonical representation | Status/caveat |
| --- | --- | --- |
| `tinyint` / `smallint` / `int` / `bigint` | string | Exact integer transport is canonical text; `decodeExactInteger` is an application opt-in. |
| `decimal` / `numeric` / `money` / `smallmoney` | number → unsupported for exact output | Use a character bind plus authored text `CAST`/`CONVERT`; do not stringify a lossy Number. |
| `real` / `float` | JavaScript `number` | Approximate binary32/binary64 values; SQL Server does not claim NaN/Infinity support. |
| `datetime2` / `datetimeoffset` | `Date` | Native convenience profile; use authored ISO/text conversion for 100ns or offset fidelity. |
| `uniqueidentifier` | string | Validate with the application schema if required. |
| `varbinary` | `Buffer` | Keep bytes or explicitly encode. |
| JSON | text | SQL Server JSON is character data; SQLBraid does not parse it, so text can preserve nested numeric lexemes. |

The binding transport is a typed Tedious request with deterministic `@p1`,
`@p2`, … names and `TYPES.*` metadata. Native `OUTPUT` rows are materialized
through `sql.rows`; output/return routine channels use explicit metadata.
Prepared-loop is the portable bulk strategy. `affectedRows` and procedure status
remain operational counts with safe-range checks; database-generated IDs use
exact text where the driver exposes it. Ordinary `undefined` IN values fail
before acquisition with `BRAID_BIND_VALUE_UNSUPPORTED`; `null` is SQL `NULL`.
Native SQL passes through transparently, while SQLBraid does not claim to parse
all T-SQL grammar.
