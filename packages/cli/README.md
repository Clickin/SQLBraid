# @sqlbraid/cli

Command-line tools for SQLBraid projects.

```sh
pnpm add --save-dev @sqlbraid/cli
```

To analyze source and metadata offline, run `pnpm exec sqlbraid check`, `inspect`, `drift` or `codegen`.

The `migrate` commands need the optional `@sqlbraid/migrate` package. Install it in the project:

```sh
pnpm add @sqlbraid/migrate
```

Use `pnpm exec sqlbraid migrate` for versioned migrations, status, baseline, repair, schema acceptance, manifest generation and schema snapshots.
`sqlbraid migrate status --check` exits with code 1 unless the migration report is current.
Database commands use the `migrations.database` factory in the shared project config and call its cleanup function afterward.
See the [migration package](https://github.com/Clickin/SQLBraid/tree/main/packages/migrate) for configuration and startup checks.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
