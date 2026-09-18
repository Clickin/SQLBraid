# Inspectors and metadata snapshots

> Capture database facts as validated, deterministic SQLBraid metadata.

Metadata is optional Node-first tooling. Runtime dialect imports do not install or require metadata or codegen packages.

Install the dialect, driver, and optional metadata package explicitly:

```bash
npm install @sqlbraid/postgres pg @sqlbraid/metadata
```

The inspector is a dialect package **subpath export**, not a separate package. Inspect an already-connected physical client:

```ts
import { hashSnapshot, validateSnapshot } from "@sqlbraid/metadata";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";

const metadata = await createPostgresInspector(client).inspect();
validateSnapshot(metadata);
console.log(hashSnapshot(metadata));
```

All first-party dialects export dedicated inspectors from their `/inspector` subpaths:
`createPostgresInspector` (`@sqlbraid/postgres/inspector`),
`createMysqlInspector` (`@sqlbraid/mysql/inspector`),
`createMariaDbInspector` (`@sqlbraid/mariadb/inspector`),
`createSqliteInspector` (`@sqlbraid/sqlite/inspector`),
`createOracleInspector` (`@sqlbraid/oracle/inspector`), and
`createMssqlInspector` (`@sqlbraid/mssql/inspector`). Inspector subpaths are intentionally separate from dialect roots.

Snapshots use:

```json
{ "format": "sqlbraid-metadata", "formatVersion": 1 }
```

The snapshot format can represent namespaces, types, relations, columns, constraints, indexes, routines, server evidence, and capture metadata. Inspector coverage is partial: PostgreSQL currently leaves namespaces empty and does not populate relation constraints or indexes. Missing fields are not evidence of absence. Canonicalization and hashing ignore capture timestamps while preserving database facts. `validateSnapshot` rejects malformed or old discriminator-less snapshots; `sqlbraid drift --before ... --after ...` compares validated snapshots.

Metadata is evidence, not a database schema lock. Routine `argumentsComplete: false` means an empty argument list is not proof of zero arity. SQLite emits no routine records. Identity means proven identity/autoincrement generation, not merely primary-key membership. Unknown write flags remain unknown.
