# @sqlbraid/runtime

The execution engine of SQLBraid. It executes DDL and DML, materializes results, and controls transactions, sessions, prepared queries and result mapping.

```sh
npm install @sqlbraid/runtime
```

This package contains the execution logic. It does not manage connections. It uses an executor or a pool from a driver adapter.

Key features:

- **Transactions**: The runtime pins one connection for each `db.tx()` callback.
- **Result mapping**: The runtime transforms raw driver rows into application values.
- **Prepared statements**: The runtime reuses the shape of a repeated query.
- **Batch execution**: The runtime executes many queries in one operation.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
