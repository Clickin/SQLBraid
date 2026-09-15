# @sqlbraid/cli

Command-line checking, manifest generation, builds, metadata drift checks,
inspection, and model generation for SQLBraid projects.

```sh
npm install --save-dev @sqlbraid/cli

npx sqlbraid check --file src/query.ts
npx sqlbraid build --file src/query.ts --out-file build/query.js
npx sqlbraid manifest --file src/query.ts
npx sqlbraid inspect diagnostics --file src/query.ts --json
```

```ts
import { defineConfig } from "@sqlbraid/cli/config";

export default defineConfig({});
```

`check` reports SQLBraid and TypeScript diagnostics for a file or project.
`build` lowers SQLBraid templates and emits JavaScript (plus a source map when
configured). `manifest` prints query manifests as JSON. `drift` compares two
metadata JSON files with `--before` and `--after`; `codegen` reads configured
metadata targets and supports `--check` and `--json`. `inspect query`,
`inspect symbol`, and `inspect diagnostics` expose source-aware tooling results.

The package exports `runCli` from its root and configuration helpers such as
`defineConfig` from `@sqlbraid/cli/config`. Vite users should use
`@sqlbraid/vite` for Vite's build pipeline.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
