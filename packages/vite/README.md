# @sqlbraid/vite

Vite 8 pre-transform for SQLBraid guarded-template lowering. It lowers only SQLBraid `@braid` semantics; Vite/Oxc/Rolldown remains responsible for TypeScript, TSX/JSX, decorators, module format, and framework transforms.

```sh
npm install @sqlbraid/vite
```

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

The plugin recognizes first-party tags from `@sqlbraid/template`, `@sqlbraid/postgres`, `@sqlbraid/mysql`, `@sqlbraid/mariadb`, `@sqlbraid/sqlite`, `@sqlbraid/oracle`, and `@sqlbraid/mssql`. It handles `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, and `.cts`, skips declarations and generated/build output, preserves TSX and downstream source-map composition, and reports compiler diagnostics with original locations.

`vite` is an optional peer dependency (`>=8.0.0`). For direct integrations, `transformSource(source, filename, options?)` is also re-exported. The plugin is framework-neutral and does not import React or TanStack Start.

See the [Vite integration guide](https://clickin.github.io/SQLBraid/getting-started/vite/) and [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
