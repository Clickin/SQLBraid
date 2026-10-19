# Vite integration

> Lower SQLBraid guarded templates in Vite 8 without taking over TypeScript or TSX transforms.

This page needs Node `>=22.18.0`. The example uses SQLite in memory, so it needs no database server.

## 1. Create a project

Install the Vite plugin together with the SQLBraid dialect package of your application.
The following commands use SQLite:

```bash
mkdir braid-vite-app && cd braid-vite-app
pnpm init --init-type module
pnpm add sqlbraid @sqlbraid/sqlite @sqlbraid/template
pnpm add --save-dev vite @sqlbraid/vite
mkdir src
```

Generated code imports helpers from `@sqlbraid/template`. Keep it as a direct runtime dependency of the application.

## 2. Add the plugin

Add the framework-neutral plugin before the normal Vite transforms. Save this code as `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

## 3. Write a dynamic query

Save this code as `src/main.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import { sql } from "@sqlbraid/sqlite";

interface UserRow {
  id: string;
  name: string;
}

const native = new DatabaseSync(":memory:");
native.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
native.exec("INSERT INTO users (name) VALUES ('Ada'), ('Grace')");

const db = createNodeSqliteDatabase(native);
const name: string | null = "Ada";
const users = await db.all(sql.rows<UserRow>`
  SELECT id, name FROM users
  /*@braid where*/
    /*@braid if ${name != null}*/
      AND name = ${name}
    /*@braid end*/
  /*@braid end*/
`);
console.log(users);
native.close();
```

## 4. Build and run

Build the file for Node. Then run the result:

```bash
pnpm exec vite build --ssr src/main.ts
node dist/main.js
```

The output is `[{ id: '1', name: 'Ada' }]`. The `AND name = ...` line stays in the SQL only when `name` is not `null`.

## Plugin options

`@sqlbraid/vite` targets Vite 8 and runs as a pre-transform. It recognizes tags imported from `@sqlbraid/*` dialect roots and `@sqlbraid/template`. If an application wraps a tag, configure custom tags:

```ts
sqlbraid({
  moduleSpecifier: "@acme/sql",
  tagExport: "query",
});
```

The plugin has these behaviors:

- It supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mts` and `.cts`.
- It skips declarations, `node_modules`, generated files and common build output.
- It reports malformed guarded SQL as Vite diagnostics, with the original filename, line and column.
- It returns non-identity source maps for transformed queries. Thus, the Vite transforms that follow can compose them.

TSX/JSX, TypeScript syntax, decorators, module format, React and TanStack transforms stay the responsibility of Vite, Oxc and Rolldown. This plugin does not transpile them.

## Runtime is separate

Vite transforms the source of the browser and the application. Database execution still needs a supported server runtime and adapter.

For a TanStack Start finance consumer, keep the Vite 8 build and the Node 24 application runtime as separate concerns:

- The plugin must keep the source map.
- The server route must create the SQLBraid database with the correct Node adapter, for example `node:sqlite`.
- Do not import a database driver that is only for Node into a browser bundle.

For direct compiler integrations, `@sqlbraid/vite` re-exports `transformSource(source, filename, options?)`. Use it only when a different bundler owns the TypeScript transform around it. Read [dynamic templates](/SQLBraid/latest/concepts/dynamic-braid.md), [SQL tags](/SQLBraid/latest/concepts/sql-tags.md) and [the Vite package README](https://github.com/Clickin/SQLBraid/tree/main/packages/vite).
