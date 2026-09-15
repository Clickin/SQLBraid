# @sqlbraid/vite

Vite 8 pre-transform plugin for SQLBraid structural-template lowering.

```sh
npm install @sqlbraid/vite vite
```

```ts
import { defineConfig } from "vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [sqlbraid()],
});
```

The plugin runs before Vite's normal transforms, recognizes SQLBraid's
first-party dialect roots and facade subpaths, and handles `.ts`, `.tsx`, `.js`,
`.jsx`, `.mts`, and `.cts`. It skips declarations and generated/build output,
returns composed source maps, and reports compiler diagnostics at original
locations. Vite/Oxc/Rolldown remains responsible for the rest of the
TypeScript, JSX, module, and framework pipeline.

`vite` is a peer dependency (`>=8.0.0`). `include` and `exclude` options use
Vite filter patterns. For custom integrations, the package also re-exports
`transformSource` and its compiler result types.

See the [Vite integration guide](https://clickin.github.io/SQLBraid/getting-started/vite/)
and the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
