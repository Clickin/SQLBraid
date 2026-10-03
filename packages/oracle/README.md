# @sqlbraid/oracle

Oracle SQL dialect and `node-oracledb` adapters for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

Use this package through the `@sqlbraid/oracle/oracledb` adapter. Give it a connected `node-oracledb` connection or pool.

### Key Details

- **Mode**: The adapter is optimized for Thin mode. Thick mode needs a separate configuration.
- **Numerics**: Exact `NUMBER` values are decimal strings. Binary floats are numbers.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
