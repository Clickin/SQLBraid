# @sqlbraid/oracle

Oracle SQL dialect and `node-oracledb` adapters for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

Use this package with a connected `node-oracledb` connection or pool via the `@sqlbraid/oracle/oracledb` adapter.

### Key Details
- **Mode**: Optimized for Thin mode; Thick mode is supported via separate configuration.
- **Numerics**: Exact `NUMBER` values are decimal strings; binary floats are numbers.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

