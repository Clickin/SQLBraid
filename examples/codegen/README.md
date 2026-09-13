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
