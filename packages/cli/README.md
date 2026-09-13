# @sqlbraid/cli

Command-line inspection, checking, guarded-template builds, and model generation for SQLBraid projects.

```sh
npm install --save-dev @sqlbraid/cli
npx sqlbraid inspect diagnostics --file src/query.ts --json
npx sqlbraid build --file src/query.ts --out-file build/query.js
```

Use `sqlbraid check --file src/query.ts` for TypeScript/Braid checking and `sqlbraid codegen` for configured metadata. The build command performs SQLBraid guarded-template lowering; it does not replace a general TypeScript/TSX transpiler. Vite users should use `@sqlbraid/vite` instead. The package also exports `defineConfig` from `@sqlbraid/cli/config`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
