# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
```

Use this package with a connected `pg` client or pool via the `@sqlbraid/postgres/pg` adapter.

### Key Details
- **Numerics**: Exact integers and numeric results are returned as strings; floating-point values are numbers.
- **Streaming**: Install the `pg-cursor` peer dependency to enable `db.stream()`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

