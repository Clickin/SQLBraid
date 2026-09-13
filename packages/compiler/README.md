# @sqlbraid/compiler

Compile SQLBraid tagged templates into typed SQL query definitions and virtual source.

```sh
npm install @sqlbraid/compiler
```

```ts
import { createVirtualOverlay } from "@sqlbraid/compiler";
const overlay = createVirtualOverlay("const query = sql`SELECT 1`;", "query.ts", {
  moduleSpecifier: "@sqlbraid/template",
});
```

The primary import is `@sqlbraid/compiler`; use it to build editor, CLI, or code-generation integrations around SQLBraid templates. See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
