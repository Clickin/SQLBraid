# @sqlbraid/bun-sql

SQLBraid adapter for Bun's `Bun.SQL` client.

```sh
bun add @sqlbraid/bun-sql @sqlbraid/postgres
```

This adapter leverages Bun's native value-template transport. You must explicitly provide a dialect (e.g., `"postgres"`) as `Bun.SQL` does not infer it.

### Key Details

- **Capabilities**: Supports native `Bun.SQL` features. Some advanced routine, streaming, or cancellation capabilities may be unavailable depending on the Bun version.
- **Precision**: Integer and decimal representation follows the defined representation profile (e.g., `1.3.14`). Exact decimal fidelity varies by database (e.g., lossless in PostgreSQL, unsupported in others) to ensure consistent behavior across Bun versions.
  See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) and the [Bun SQL guide](https://bun.com/docs/runtime/sql) for details.
