# @sqlbraid/core

Public TypeScript contracts for SQLBraid templates, rendered statements,
execution boundaries, result mapping, and adapter capabilities.

```sh
npm install @sqlbraid/core
```

Use this low-level package when authoring an adapter or integration. It defines
contracts only and does not connect to a database or execute queries; use
`@sqlbraid/runtime` for application execution.

Driver authors can import `@sqlbraid/core/driver` for explicit cleanup scopes,
safe result-property definition, and savepoint-name validation. Cleanup scopes
run registered actions in LIFO order exactly once, preserve the primary failure,
aggregate cleanup failures under `BRAID_RESOURCE_CLEANUP`, and support disarm
after ownership transfer without forcing synchronous actions through Promises.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/).
