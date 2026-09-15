# @sqlbraid/template

SQL tagged-template primitives for custom SQLBraid dialects and adapters.

```sh
npm install @sqlbraid/template
```

Use `createSqlTag` with a dialect from `@sqlbraid/core`, or use the default
PostgreSQL lexical profile. Ordinary interpolations are bound values; use the
explicit structural helpers (`ident`, `fragment`, `list`, `join`, and `raw`)
when SQL structure is intentional. `raw` is trusted/unsafe input.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
