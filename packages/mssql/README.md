# @sqlbraid/mssql

Microsoft SQL Server dialect and Tedious adapters for SQLBraid.

```sh
npm install @sqlbraid/mssql tedious
```

The application supplies a connected Tedious connection or pool; use
`@sqlbraid/mssql/tedious` for the adapter. Integer results are decimal strings,
approximate floating-point values are numbers, and binary values are
`Uint8Array`. Use native SQL Server `OUTPUT` for rows returned by writes;
SQLBraid does not rewrite SQL.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).

If the Tedious connection does not expose the prepared-statement protocol
(`prepare`, `execute`, or `unprepare`), the adapter rejects with
`UnsupportedFeatureError` using feature `statement.prepare` and code
`BRAID_PREPARE_UNSUPPORTED`.
