# @sqlbraid/cli

Command-line tools for SQLBraid projects.

```sh
npm install --save-dev @sqlbraid/cli
```

To analyze source and metadata offline, run `npx sqlbraid check`, `inspect`, `drift` or `codegen`.

Use `npx sqlbraid migrate` for versioned migrations, status, baseline, repair, schema acceptance, manifest generation and schema snapshots.
`sqlbraid migrate status --check` exits with code 1 unless the migration report is current.
Database commands use the `migrations.database` factory in the shared project config and call its cleanup function afterward.
See the [migration package](https://github.com/Clickin/SQLBraid/tree/main/packages/migrate) for configuration and startup checks.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
