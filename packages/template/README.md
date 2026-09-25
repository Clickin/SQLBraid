# @sqlbraid/template

Tagged-template primitives for building custom SQLBraid dialects and adapters.

```sh
npm install @sqlbraid/template
```

Provides `createSqlTag` and structural helpers (`ident`, `fragment`, `list`, `join`, and `raw`). Ordinary interpolations are value binds; `raw` emits trusted SQL verbatim. Never pass untrusted input to `raw`.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
