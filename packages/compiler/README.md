# @sqlbraid/compiler

Compile SQLBraid guarded templates into typed SQL query definitions and source-mapped virtual source.

```sh
npm install @sqlbraid/compiler
```

```ts
import { transformSource } from "@sqlbraid/compiler";
const result = transformSource(source, "src/query.ts");
```

`transformSource` lowers SQLBraid guarded-template semantics only. It does not transpile TypeScript, TSX/JSX, decorators, module format, or framework code; Vite/Oxc/Rolldown remains responsible for those transforms. Use `@sqlbraid/vite` for the Vite 8 pre-transform and preserve its returned source map when composing downstream transforms.

The default tag discovery includes the canonical `sqlbraid/*` facade
subpaths as well as the granular `@sqlbraid/*` dialect roots. Use
`moduleSpecifier` or `moduleSpecifiers` for application wrappers.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
