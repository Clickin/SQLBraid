---
title: Vite integration
description: Lower SQLBraid guarded templates in Vite 8 without taking over TypeScript or TSX transforms.
---

Install the Vite plugin together with the SQLBraid dialect package of your application:

```bash
npm install sqlbraid @sqlbraid/vite
```

Add the framework-neutral plugin before the normal Vite transforms:

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

`@sqlbraid/vite` targets Vite 8 and runs as a pre-transform. It recognizes SQLBraid tags that are imported from the granular `@sqlbraid/*` dialect roots and from the matching `sqlbraid/*` facade subpaths. If an application wraps a tag, configure custom tags:

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

For direct compiler integrations, `@sqlbraid/vite` re-exports `transformSource(source, filename, options?)`. Use it only when a different bundler owns the TypeScript transform around it. Read [dynamic templates](/SQLBraid/concepts/dynamic-braid/), [SQL tags](/SQLBraid/concepts/sql-tags/) and [the Vite package README](https://github.com/Clickin/SQLBraid/tree/main/packages/vite).
