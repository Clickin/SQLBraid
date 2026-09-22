# @sqlbraid/mssql

Microsoft SQL Server dialect and `tedious` adapters for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

Use this package with a connected `tedious` connection or pool via the `@sqlbraid/mssql/tedious` adapter.

### Key Details
- **Numerics**: Integer results are decimal strings; binary floats are numbers.
- **Writes**: Use native SQL Server `OUTPUT` for rows returned by write operations.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

