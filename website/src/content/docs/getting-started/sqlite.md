---
title: Five-minute SQLite quickstart
description: Run your first SQLBraid query with Node's built-in SQLite driver.
---

This path uses Node `>=22.18.0` and `node:sqlite`; no database server is required. The first query is a plain tagged template and needs no SQLBraid compiler. The second adds dynamic `@braid` and uses the shipped lowering command.

:::note Verification status
The package names below are the intended integration path. PV15 final package
and database verification is pending; this guide does not claim publication,
CI, or release-gate completion.
:::

## 1. Create a project

```bash
mkdir braid-sqlite && cd braid-sqlite
npm init -y
npm pkg set type=module
npm install @sqlbraid/sqlite
npm install --save-dev typescript @types/node@22
mkdir src
```

## 2. Run one simple query

Create `src/index.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

interface UserRow {
  id: number;
  name: string;
}

const native = new DatabaseSync(":memory:");
try {
  native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  native.prepare("INSERT INTO users (name) VALUES (?)").run("Ada");

  const db = createNodeSqliteDatabase(native);
  const requestedId = 1;
  const users = await db.all(sql.rows<UserRow>`
    SELECT id, name FROM users WHERE id = ${requestedId}
  `);
  console.log(users);
} finally {
  native.close();
}
```

Node 22.18.0 can run this erasable TypeScript directly:

```bash
node src/index.ts
```

The output is a row array such as `[{ id: 1, name: "Ada" }]`. The requested ID is a driver-bound value, not interpolated SQL text.

The node:sqlite adapter renders the logical statement to text with `?`
placeholders, then uses the documented `DatabaseSync.prepare(text)` and
`StatementSync` APIs. Materialization and hint validation happen before any
statement execution. Reuse is adapter-owned when configured; SQLBraid does not
invoke `SQLTagStore` through an undocumented callable path.

## 3. Add dynamic @braid and lower it

Replace the `requestedId` declaration and query block in `src/index.ts` with this one:

```ts
const requestedId: number | undefined = 1;
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name
  FROM users
  /*@braid where*/
    /*@braid if ${requestedId !== undefined}*/
      AND id = ${requestedId}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
```

Build the TypeScript source with SQLBraid's compiler lowering, then run the emitted JavaScript:

```bash
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

The compiler lowers the guarded template into `build/index.js`. `@braid where` emits `WHERE` only when a child emits SQL and removes a leading `AND`/`OR`. The condition is evaluated before the guarded value; inactive branch expressions are not evaluated. The requested ID remains an ordinary SQLite bind.

## What happened

1. `DatabaseSync` owns the in-memory SQLite resource.
2. `createNodeSqliteDatabase(native)` adapts that physical resource to SQLBraid's runtime.
3. `sql.rows<UserRow>` declares that the statement returns rows shaped like `UserRow`.
4. An ordinary value becomes a driver bind (`?` for SQLite), never SQL text.
5. The compiler preserves the dynamic template's lazy guarded evaluation.

For a write, use `sql.command` and `db.execute`. For exactly one row, use `db.one`; it throws a cardinality error unless the result contains one row. See [SQL tags and result kinds](/SQLBraid/concepts/sql-tags/).

:::caution Node SQLite support
`node:sqlite` is the first-party SQLite adapter used by this release. The SQLite
adapter does not support routine calls; streaming uses
`StatementSync.iterate()`. Set `integerMode: "bigint"` in
`createNodeSqliteDatabase(native, { integerMode: "bigint" })` when INTEGER
results must be read as `bigint`; use the matching
`typePolicyForIntegerMode("bigint")`. SQLite scalar/aggregate/window functions
are ordinary SQL functions, and virtual-table/table-valued extensions are
ordinary row queries, not stored procedures.
:::
