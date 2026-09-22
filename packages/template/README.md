# @sqlbraid/template

Tagged-template primitives for building custom SQLBraid dialects and adapters.

```sh
npm install @sqlbraid/template
```

Provides `createSqlTag` and structural helpers (`ident`, `fragment`, `list`, `join`, and `raw`) to build safe, bindable SQL templates. Ordinary interpolations are treated as value binds by default.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.

