# Codegen example

To run codegen, you need only the SQLite metadata snapshot and the config in
this directory. You do not need a live database. The release gate installs the
packed CLI, codegen and runtime packages into a clean temporary project:

```bash
pnpm run test:examples
```

The packed project runs these commands:

```bash
npm install @sqlbraid/cli @sqlbraid/codegen @sqlbraid/sqlite
npx sqlbraid codegen
npx tsc --project tsconfig.json --noEmit
npx sqlbraid codegen --check
```

The last command, `--check`, proves that the generated model is deterministic.
It also proves that the model matches the snapshot and the config.

## Standalone prebuild

Vite is optional. For one source file, compile the query before the
application build:

```bash
sqlbraid build --file src/queries.ts --out-file dist/queries.js
node dist/queries.js
```

The compiler writes the source map next to the output. Metadata capture is a
separate step in code:

1. Call the correct inspector.
2. Serialize its `MetadataSnapshot` to JSON.
3. Give that snapshot to `sqlbraid codegen`.

This procedure does not store credentials or connection configuration.
