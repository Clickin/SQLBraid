# Codegen example

The checked-in SQLite metadata snapshot and config are enough to run codegen
without a live database. The release gate installs the packed CLI and
codegen/runtime packages into a clean temporary project:

```bash
pnpm run test:examples
```

The exact packed-project flow is:

```bash
npm install @sqlbraid/cli @sqlbraid/codegen @sqlbraid/sqlite
npx sqlbraid codegen
npx tsc --project tsconfig.json --noEmit
npx sqlbraid codegen --check
```

The final `--check` proves that the generated model is deterministic and
matches the snapshot/config.

## Standalone prebuild

Vite is optional. For a single source file, compile the authored query before
the application build:

```bash
sqlbraid build --file src/queries.ts --out-file dist/queries.js
node dist/queries.js
```

The compiler preserves the generated source map next to the output. Metadata
capture is a separate programmatic step: call the appropriate inspector,
serialize its `MetadataSnapshot` to JSON, then pass that snapshot to
`sqlbraid codegen`; no credentials or connection configuration is stored by
this recipe.
