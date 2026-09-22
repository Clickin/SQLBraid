# @sqlbraid/runtime

Core execution engine for SQLBraid. Handles result materialization, transactions, sessions, prepared queries, and result mapping.

```sh
npm install @sqlbraid/runtime
```

This package provides the execution logic. It does not manage connections itself but uses an executor or pool supplied by a driver adapter.

Key features:
- **Transaction Management**: Pins connections for `db.tx()` callbacks.
- **Result Mapping**: Transforms raw driver rows into application values.
- **Prepared Statements**: Optimizes repetitive query shapes.
- **Batch Execution**: Efficiently executes multiple queries in one go.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

