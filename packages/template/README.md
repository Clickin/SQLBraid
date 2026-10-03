# @sqlbraid/template

Tagged-template primitives for building custom SQLBraid dialects and adapters.

```sh
npm install @sqlbraid/template
```

This package gives `createSqlTag` and the structural helpers `ident`, `fragment`, `list`, `join` and `raw`. Ordinary interpolations are value binds. `raw` puts trusted SQL into the statement without change. Do not give untrusted input to `raw`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
