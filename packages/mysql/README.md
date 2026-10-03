# @sqlbraid/mysql

MySQL dialect and `mysql2` adapters for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

Use this package through the `@sqlbraid/mysql/mysql2` adapter. Give it a connected `mysql2` connection or pool.

### Key Details

- **Numerics**: If exact integer and decimal values must stay strings, use the lossless text profile.
- **Streaming**: The adapter uses the native stream support of `mysql2`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
