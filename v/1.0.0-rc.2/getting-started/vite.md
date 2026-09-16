# Vite integration

> Lower SQLBraid guarded templates in Vite 8 without taking over TypeScript or TSX transforms.

Install the Vite plugin beside the SQLBraid dialect package used by your application:

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

`@sqlbraid/vite` targets Vite 8 and runs as a pre-transform. It recognizes SQLBraid tags imported from the granular `@sqlbraid/*` dialect roots and the matching `sqlbraid/*` facade subpaths. Configure custom tags when an application wraps a tag:

```ts
sqlbraid({
  moduleSpecifier: "@acme/sql",
  tagExport: "query",
});
```

The plugin supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, and `.cts`; skips declarations, `node_modules`, generated files, and common build output; and reports malformed guarded SQL as Vite diagnostics with the original filename and line/column. It returns non-identity source maps for transformed queries so downstream Vite transforms can compose them. TSX/JSX, TypeScript syntax, decorators, module format, React, and TanStack transforms remain Vite/Oxc/Rolldown responsibilities—this plugin does not transpile them.

## Runtime is separate

Vite transforms browser/application source. Database execution still needs a supported server runtime and adapter. For a TanStack Start finance consumer, keep the Vite 8 build and Node 24 application runtime as separate concerns: the plugin must preserve the source map and the server route must create the SQLBraid database with the appropriate Node adapter (for example `node:sqlite`). Do not import a Node-only database driver into a browser bundle.

For direct compiler integrations, `@sqlbraid/vite` re-exports `transformSource(source, filename, options?)`; use it only when another bundler owns the surrounding TypeScript transform. See [dynamic templates](/SQLBraid/v/1.0.0-rc.2/concepts/dynamic-braid.md), [SQL tags](/SQLBraid/v/1.0.0-rc.2/concepts/sql-tags.md), and [the Vite package README](https://github.com/Clickin/SQLBraid/tree/main/packages/vite).
