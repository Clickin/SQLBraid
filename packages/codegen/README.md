# @sqlbraid/codegen

Generate TypeScript relation models from SQLBraid database metadata snapshots.

```sh
npm install @sqlbraid/codegen @sqlbraid/metadata
```

Pass a validated snapshot and matching database type policy to generate source
for application models. Database-specific packages obtain snapshots; this
package does not connect to databases.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
