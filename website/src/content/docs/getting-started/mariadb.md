---
title: MariaDB quickstart
description: Connect SQLBraid to MariaDB Connector/Node.js while keeping MariaDB syntax explicit.
---

Install the separate MariaDB dialect and the official Connector/Node.js driver:

```bash
npm install @sqlbraid/mariadb mariadb
```

Use the `/mariadb` adapter subpath with a connected connection or an explicit
pool factory:

```ts
import mariadb from "mariadb";
import { sql } from "@sqlbraid/mariadb";
import { createMariaDbDatabase } from "@sqlbraid/mariadb/mariadb";

const connection = await mariadb.createConnection({
  host: "127.0.0.1",
  user: "sqlbraid",
  password: "password",
  database: "app",
});
const db = createMariaDbDatabase(connection);
const users = await db.all(sql.rows<{ id: number; name: string }>`
  SELECT id, name FROM users WHERE id = ${1}
`);
```

The dialect is `mariadb`, not `mysql`. MariaDB-specific syntax remains authored
SQL. Current capability fixtures cover documented `INSERT ... RETURNING`,
`DELETE ... RETURNING`, `REPLACE ... RETURNING`, sequences, CTEs, and JSON
functions. `UPDATE ... RETURNING` is not claimed; an
`INSERT ... ON DUPLICATE KEY UPDATE ... RETURNING` form requires matching
server evidence before it is listed as supported.

The adapter uses Connector/Node.js value-only execution, native row streaming,
and one `connection.batch()` call for `db.bulk()` (`native-bulk`). Root bulk is
not implicitly transactional and has no portable auto-chunking promise. Use
`db.tx()` when callback transaction atomicity is required.

A `mysql2` connection may work against MariaDB as best-effort compatibility, but
it is not Official MariaDB syntax or protocol evidence. PV16 exact-final-SHA
verification remains pending; package installation and a local fixture are not
release support claims.
