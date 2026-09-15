# @sqlbraid/mariadb

MariaDB dialect and official MariaDB Connector/Node.js adapters for SQLBraid.

```sh
npm install @sqlbraid/mariadb mariadb
```

The application supplies a connected Connector/Node.js connection or pool; use
`@sqlbraid/mariadb/mariadb` for the adapter. Select the lossless text profile
when exact integer and decimal values must remain strings. Streaming and batch
operations use the connector's native APIs. SQLBraid does not rewrite
MySQL-family SQL.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
