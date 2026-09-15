# @sqlbraid/compiler

Compiler APIs for analyzing, checking, lowering, and emitting TypeScript
sources that contain SQLBraid tagged templates. This package is for build
tools, editor integrations, and custom pipelines.

```sh
npm install @sqlbraid/compiler
```

```ts
import { discoverQueries, transformSource } from "@sqlbraid/compiler";

const source = [
  'import { sql } from "@sqlbraid/postgres";',
  "const query = sql`SELECT 1 /*@braid if ${true}*/ WHERE id = ${1} /*@braid end*/`;",
].join("\n");
const fileName = "src/query.ts";

const analysis = discoverQueries(source, fileName, {
  moduleSpecifier: "@sqlbraid/postgres",
});
const transformed = transformSource(source, fileName);
console.log(analysis.queries.length, transformed.code, transformed.map);
```

`discoverQueries` returns parsed query information and compiler diagnostics.
`transformSource` returns `{ code, map, diagnostics }` and lowers SQLBraid
structural directives while preserving source-map information. Use
`createVirtualOverlay` for type-checking overlays, `checkSource`,
`checkSourceDetailed`, or `checkProject` for diagnostics, and `emitSource` when
you need TypeScript output. Configure custom tags with `moduleSpecifier`,
`moduleSpecifiers`, `tagExport`, or compiler options.

The default module list includes SQLBraid's granular `@sqlbraid/*` dialect roots
and the matching `sqlbraid/*` facade subpaths. Vite users can use the
`@sqlbraid/vite` plugin, which re-exports `transformSource`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
