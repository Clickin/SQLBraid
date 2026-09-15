# @sqlbraid/mysql

MySQL dialect and `mysql2` adapters for SQLBraid.

```sh
npm install @sqlbraid/mysql mysql2
```

The application supplies a connected `mysql2` connection or pool; use
`@sqlbraid/mysql/mysql2` for the adapter. Select the lossless text profile when
exact integer and decimal values must remain strings. MySQL has no generic
DML `RETURNING`; SQLBraid does not rewrite writes. The optional streaming path
uses mysql2's native stream support.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
