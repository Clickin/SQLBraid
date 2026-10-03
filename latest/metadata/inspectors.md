# Inspectors and metadata snapshots

> Capture database facts as validated, deterministic SQLBraid metadata.

Metadata is optional, Node-first tooling. Runtime dialect imports do not install or require the metadata or codegen packages.

Install the dialect, the driver and the optional metadata package explicitly:

```bash
npm install @sqlbraid/postgres pg @sqlbraid/metadata
```

The inspector is a **subpath export** of the dialect package. It is not a separate package. Inspect a physical client that is already connected:

```ts
import { hashSnapshot, validateSnapshot } from "@sqlbraid/metadata";
import { createPostgresInspector } from "@sqlbraid/postgres/inspector";

const metadata = await createPostgresInspector(client).inspect();
validateSnapshot(metadata);
console.log(hashSnapshot(metadata));
```

All first-party dialects export dedicated inspectors from their `/inspector` subpaths:

- `createPostgresInspector` (`@sqlbraid/postgres/inspector`);
- `createMysqlInspector` (`@sqlbraid/mysql/inspector`);
- `createMariaDbInspector` (`@sqlbraid/mariadb/inspector`);
- `createSqliteInspector` (`@sqlbraid/sqlite/inspector`);
- `createOracleInspector` (`@sqlbraid/oracle/inspector`);
- `createMssqlInspector` (`@sqlbraid/mssql/inspector`).

The inspector subpaths are separate from the dialect roots on purpose.

Snapshots use:

```json
{ "format": "sqlbraid-metadata", "formatVersion": 1 }
```

The snapshot format can represent namespaces, types, relations, columns, constraints, indexes, routines, server evidence and capture metadata.

- Inspector coverage is partial. PostgreSQL currently leaves namespaces empty. It does not fill relation constraints or indexes.
- Missing fields are not evidence of absence.
- Canonicalization and hashing ignore capture timestamps. They keep the database facts.
- `validateSnapshot` rejects malformed snapshots and old snapshots without the discriminator.
- `sqlbraid drift --before ... --after ...` compares validated snapshots.

Metadata is evidence. It is not a lock on the database schema.

- Routine `argumentsComplete: false` means that an empty argument list does not prove zero arity.
- SQLite emits no routine records.
- Identity means proven identity or autoincrement generation. Membership in the primary key alone is not identity.
- Unknown write flags stay unknown.
