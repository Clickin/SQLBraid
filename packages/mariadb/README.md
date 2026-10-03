# @sqlbraid/mariadb

MariaDB dialect and official MariaDB Connector/Node.js adapters for SQLBraid.

```sh
npm install @sqlbraid/mariadb mariadb
```

Use this package through the `@sqlbraid/mariadb/mariadb` adapter. Give it a connected Connector/Node.js connection or pool.

### Key Details

- **Numerics**: If exact integer and decimal values must stay strings, use the lossless text profile.
- **Streaming**: The adapter uses the native APIs of the connector.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
