# @sqlbraid/metadata

Utilities for SQLBraid database metadata snapshots.

```sh
npm install @sqlbraid/metadata
```

Use this package to validate, canonicalize and compare database snapshots for tooling or code generation. It does not connect to databases.

Node 16.20.2 or later is compatible. The packed migration consumer checks
snapshot hashing and schema drift on that version. Use a supported Node LTS release for new deployments.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
