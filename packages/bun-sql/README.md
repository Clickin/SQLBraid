# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client.

```sh
bun add @sqlbraid/bun-sql @sqlbraid/postgres
```

This adapter uses the native value-template transport of Bun. `Bun.SQL` does not infer the dialect. You must give the dialect explicitly, for example `"postgres"`.

### Key Details

- **Tested version**: Bun 1.3.14.
- **Capabilities**: Streams, routine calls and active cancellation are unsupported. They fail with explicit `BRAID_*` errors.
- **Precision**: Exact integers are strings. Exact decimals are strings in PostgreSQL. In MySQL, MariaDB and SQLite, exact decimals are unsupported.
  See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the [Bun SQL guide](https://bun.com/docs/runtime/sql) for details.
