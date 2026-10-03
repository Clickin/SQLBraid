# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
```

Use this package through the `@sqlbraid/postgres/pg` adapter. Give it a connected `pg` client or pool.

### Key Details

- **Numerics**: Exact integers and numeric results are strings. Floating-point values are numbers.
- **Streaming**: To use `db.stream()`, install the `pg-cursor` peer dependency.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
