# @sqlbraid/metadata

Types and utilities for SQLBraid database metadata snapshots: validation,
canonicalization, hashing, identity, and drift comparison.

```sh
npm install @sqlbraid/metadata
```

Parse and validate snapshots supplied by database-specific inspectors, then
compare or hash them for tooling and code generation. This package does not
connect to databases.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
