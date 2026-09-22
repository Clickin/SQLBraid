# @sqlbraid/mariadb

MariaDB dialect and official MariaDB Connector/Node.js adapters for SQLBraid.

```sh
npm install @sqlbraid/mariadb mariadb
```

Use this package with a connected Connector/Node.js connection or pool via the `@sqlbraid/mariadb/mariadb` adapter.

### Key Details
- **Numerics**: Use the lossless text profile if exact integer and decimal values must remain strings.
- **Streaming**: Uses the connector's native APIs.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

