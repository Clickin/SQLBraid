# @sqlbraid/oracle

Oracle SQL dialect and node-oracledb adapters for SQLBraid.

```sh
npm install @sqlbraid/oracle oracledb
```

The application supplies a connected node-oracledb connection or pool and
uses `@sqlbraid/oracle/oracledb`. Thin mode is the documented target; configure
Thick mode separately when needed. The default policy exposes exact Oracle
`NUMBER` values as decimal strings, approximate binary floats as numbers, and
binary data as `Uint8Array`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
