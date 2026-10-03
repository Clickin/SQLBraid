# SQL Server quickstart

> Connect SQLBraid to Tedious with deterministic SQL Server parameter hints.

Install the SQLBraid runtime facade and Tedious together:

```bash
npm install sqlbraid tedious
```

The portable root exposes the SQL Server dialect and the hint factories. The Node driver adapter is under `/tedious`:

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
  options: {
    database: process.env.SQLSERVER_DATABASE ?? "app",
    encrypt: true,
    trustServerCertificate: process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE === "true",
  },
});
await new Promise<void>((resolve, reject) => {
  connection.once("connect", (error) => (error ? reject(error) : resolve()));
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

TLS encryption and certificate verification are enabled by default. Set
`SQLSERVER_TRUST_SERVER_CERTIFICATE=true` explicitly only for an isolated local
development server with a self-signed certificate. Do not use that bypass for
remote or production servers. Configure a trusted certificate.

Tedious receives deterministic parameter names: `@p1`, `@p2`, .... `sql.bind` selects the database type. It does not turn the value into SQL text. Scalar OUTPUT and INOUT routine parameters require explicit hints. To get a T-SQL integer RETURN status, give explicit `procedure: { name, parameterNames }` metadata in the `sql.call` declaration. SQLBraid does not parse arbitrary `EXEC` text to guess the identity.

The Tedious binding adapter materializes a logical statement as a typed request:
deterministic `@p1`, `@p2`, … names, `TYPES.*` mappings, encoded values and
facets. The description, the hint validation and the exactness checks occur
before lease acquisition. Tedious owns the effective reuse. Failures in this
work are `materialize` errors without driver I/O.

## Capability boundaries

- The documented candidate is Tedious 20.0.0 on Node 22.18.0/Linux x64. The
  [runtime and driver support matrix](/SQLBraid/v/1.0.2/reference/support.md) records
  labels for each exact tuple of database, driver, profile, runtime and
  capability, with its revision and workflow evidence. A neighboring version or
  a package installation is not certification. The final exact-SHA Runtime,
  Docs and Release gates and an explicit release authorization stay separate
  requirements.
- The target uses SQL Server 2022 CU18 Developer, Linux x64. Local ARM
  emulation is outside the verification scope of this guide.
- Common values without a hint use the Tedious inference of the adapter. Use an explicit hint for `null`, custom objects, precision and scale, lengths or SQL Server-specific types.
- The adapter keeps multiple recordsets. It does not flatten them into invented single-row results.
- `CURSOR VARYING OUTPUT` is not an application cursor channel. It is rejected with `BRAID_CALL_CURSOR_UNSUPPORTED`. Batches that read a local cursor and emit `SELECT` rows return those rows as ordinary result sets.

Tedious exposes `decimal`/`numeric`, `money` and `smallmoney` through a
JavaScript `number`. Thus, SQLBraid fails closed with `BRAID_RESULT_EXACTNESS`.
It does not convert a lossy exact value to a string. Tedious `BIGINT` text is
normalized to the canonical exact string.

- For exact decimal or money results, write a text expression such as
  `CONVERT(varchar(100), exact_column)` with a correct length. Declare a string
  result.
- For exact input, use a character hint (`mssqlParameter.nvarchar(...)`). Let
  your SQL select the conversion, for example
  `CAST(@nvarchar_parameter AS decimal(38, 18))`. The native typed
  DECIMAL/NUMERIC/MONEY convenience path is bounded JavaScript `number` input.
  It does not give arbitrary-precision fidelity.
- Native temporal values use `Date`. `Date` does not keep the 100ns precision
  or the complete offset semantics of SQL Server. When exact temporal text is
  important, write `CONVERT(varchar(...), datetime2_or_datetimeoffset, style)`.

For the shape of the explicit procedure metadata and the heterogeneous
`sql.call` result rules, read [routine calls](/SQLBraid/v/1.0.2/concepts/routines.md).

## Tedious representation profile

The documented free test target is SQL Server 2022 CU18 Developer with
Tedious 20.0.0 on Node 22.18.0/Linux x64. The support manifest assigns the
evidence label. This page does not. A different SQL Server edition or runtime is
a separate profile.

| SQL Server value                               | Driver raw / SQLBraid canonical representation | Status/caveat                                                                                               |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tinyint` / `smallint` / `int` / `bigint`      | string                                         | Exact integer transport is canonical text; `decodeExactInteger` is an application opt-in.                   |
| `decimal` / `numeric` / `money` / `smallmoney` | number → unsupported for exact output          | Use a character bind plus authored text `CAST`/`CONVERT`; do not stringify a lossy Number.                  |
| `real` / `float`                               | JavaScript `number`                            | Approximate binary32/binary64 values; SQL Server does not claim NaN/Infinity support.                       |
| `datetime2` / `datetimeoffset`                 | `Date`                                         | Native convenience profile; use authored ISO/text conversion for 100ns or offset fidelity.                  |
| `uniqueidentifier`                             | string                                         | Validate with the application schema if required.                                                           |
| `varbinary`                                    | `Buffer`                                       | Keep bytes or explicitly encode.                                                                            |
| JSON                                           | text                                           | SQL Server JSON is character data; SQLBraid does not parse it, so text can preserve nested numeric lexemes. |

- The binding transport is a typed Tedious request with deterministic `@p1`,
  `@p2`, … names and `TYPES.*` metadata.
- Native `OUTPUT` rows are materialized through `sql.rows`. The output and
  return routine channels use explicit metadata.
- Prepared-loop is the portable bulk strategy.
- `affectedRows` and the procedure status stay operational counts with
  safe-range checks. IDs that the database generates use exact text where the
  driver exposes it.
- Ordinary `undefined` IN values fail before acquisition with
  `BRAID_BIND_VALUE_UNSUPPORTED`. `null` is SQL `NULL`.
- Native SQL passes through without change. SQLBraid does not claim to parse
  all T-SQL grammar.
