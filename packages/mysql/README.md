# @sqlbraid/mysql

MySQL dialect and `mysql2` adapters for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

Use this package with a connected `mysql2` connection or pool via the `@sqlbraid/mysql/mysql2` adapter.

### Key Details
- **Numerics**: Use the lossless text profile if exact integer and decimal values must remain strings.
- **Streaming**: Uses `mysql2` native stream support.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

