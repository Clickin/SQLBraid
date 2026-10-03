# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client.

```sh
bun add @sqlbraid/bun-sql @sqlbraid/postgres
```

This adapter uses the native value-template transport of Bun. `Bun.SQL` does not infer the dialect. You must give the dialect explicitly, for example `"postgres"`.

### Key Details

- **Capabilities**: The adapter supports the native `Bun.SQL` features. Some advanced routine, streaming or cancellation capabilities can be unavailable in some Bun versions.
- **Precision**: The representation of integers and decimals follows the defined representation profile (for example, `1.3.14`). The fidelity of exact decimals is different for each database: lossless in PostgreSQL, unsupported in others. This keeps the behavior the same across Bun versions.
  See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the [Bun SQL guide](https://bun.com/docs/runtime/sql) for details.
