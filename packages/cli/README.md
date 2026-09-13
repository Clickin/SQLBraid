# @sqlbraid/cli

Command-line inspection, checking, and model generation for SQLBraid projects.

```sh
npm install @sqlbraid/cli
npx sqlbraid inspect diagnostics --file src/query.ts --json
```

Replace `src/query.ts` with an existing TypeScript source file. Use `sqlbraid check --file src/query.ts` for TypeScript/Braid checking and `sqlbraid codegen` to generate models from configured metadata. The package also exports `defineConfig` from `@sqlbraid/cli/config`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
