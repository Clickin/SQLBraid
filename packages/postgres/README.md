# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
```

The application supplies a connected `pg` client or pool; use
`@sqlbraid/postgres/pg` for the adapter. Exact integer and numeric results are
strings by default, while approximate floating-point values are numbers. The
optional `pg-cursor` peer adds `db.stream()` support.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
