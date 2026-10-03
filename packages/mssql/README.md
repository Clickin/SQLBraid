# @sqlbraid/mssql

Microsoft SQL Server dialect and `tedious` adapters for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

Use this package through the `@sqlbraid/mssql/tedious` adapter. Give it a connected `tedious` connection or pool.

### Key Details

- **Numerics**: Integer results are decimal strings. Binary floats are numbers.
- **Writes**: To return rows from a write operation, use the native SQL Server `OUTPUT` clause.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
