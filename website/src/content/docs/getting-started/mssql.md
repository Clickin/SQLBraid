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

Tedious receives deterministic `@p1`, `@p2`, ... parameter names. `sql.bind` selects the database type; it does not turn the value into SQL text. OUT/return-value routine binding is Unsupported in this RC.

## Capability boundaries

- SQL Server portable roots and the Tedious adapter are conservatively Compatible until same-revision CI establishes Official coverage.
- Local Node 22.18.0 tests use SQL Server 2022 CU18 (16.0.4185.3), Linux x64; ARM emulation is not an Official ARM claim.
- Unhinted common values use adapter-local Tedious inference. Use an explicit hint for `null`, custom objects, precision/scale, lengths, or SQL Server-specific types.
- The adapter preserves multiple recordsets instead of flattening them into fabricated single-row results.

Tedious returns `decimal`/`numeric` as JavaScript numbers; this default policy does not promise arbitrary-precision decimal results. Explicit decimal-text inputs exceeding 15 significant digits are rejected with `BRAID_BIND_DECIMAL_EXACTNESS`. For exact decimal text, select an explicit SQL string conversion and declare a string result contract. `bigint` results use strings. Date/time values use `Date`, which does not preserve the original offset or sub-millisecond precision.

See [runtime and driver support](/SQLBraid/reference/support/) for the evidence labels and current matrix.
