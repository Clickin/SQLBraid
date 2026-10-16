# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
pnpm add @sqlbraid/postgres pg
```

Use this package through the `@sqlbraid/postgres/pg` adapter. Give it a connected `pg` client or pool.

### Neon (WebSocket)

Use the `@sqlbraid/postgres/neon` adapter with a `Pool` or `Client` from `@neondatabase/serverless`. Set `neonConfig.webSocketConstructor` first. The adapter is tested against a local WebSocket proxy, so its support label is Compatible. The pooled Neon endpoint can reject named prepared statements, so `statement.prepare` is `guarded` for this adapter.

```ts
import { Pool } from "@neondatabase/serverless";
import { createNeonPoolDatabase } from "@sqlbraid/postgres/neon";

const db = createNeonPoolDatabase(new Pool({ connectionString: process.env.DATABASE_URL }));
```

### Neon (HTTP)

Use the `@sqlbraid/postgres/neon-http` adapter with the `neon()` query function. Each statement is one HTTP request, so the adapter pins no connection. `db.tx()` and `db.session()` reject. `db.bulk()` runs in one server-side transaction through `sql.transaction()`.

```ts
import { neon } from "@neondatabase/serverless";
import { createNeonHttpDatabase } from "@sqlbraid/postgres/neon-http";

const db = createNeonHttpDatabase(neon(process.env.DATABASE_URL!));
```

- The adapter sets the result options and the type parsers for each query. Exact numerics, JSON, temporal values and arrays stay text.
- `statement.stream`, `statement.cancel` and routine calls are unsupported. An active `AbortSignal` is rejected before I/O.

### postgres.js

Use the `@sqlbraid/postgres/postgres-js` adapter with a [postgres.js](https://github.com/porsager/postgres) client. Spread `postgresJsOptions()` into the client options. The adapter checks them and rejects a client that does not use the lossless text parsers.

```ts
import postgres from "postgres";
import { createPostgresJsDatabase, postgresJsOptions } from "@sqlbraid/postgres/postgres-js";

const db = createPostgresJsDatabase(postgres(process.env.DATABASE_URL!, postgresJsOptions()));
```

- Each root operation and each transaction reserves one connection with `sql.reserve()`.
- Array parameters are text literals such as `'{1,2}'`, because `fetch_types` is off.
- `statement.cancel` and routine calls are unsupported. An active `AbortSignal` is rejected before I/O.
- A discarded lease runs `ROLLBACK` and `DISCARD ALL` before it returns to the pool, because postgres.js does not expose the physical connection.

### PGlite

Use the `@sqlbraid/postgres/pglite` adapter with a [PGlite](https://pglite.dev) instance. PGlite is one connection in one process, so SQLBraid must own the instance. A direct call on it during `db.tx()` joins the open transaction.

```ts
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@sqlbraid/postgres/pglite";

const db = createPgliteDatabase(await PGlite.create());
```

- The adapter sets parsers for each query, so exact numerics, JSON, temporal values and arrays stay text.
- `statement.stream`, `statement.cancel` and routine calls are unsupported. An active `AbortSignal` is rejected before I/O.
- The adapter does not close the instance.

### Key Details

- **Numerics**: Exact integers and numeric results are strings. Floating-point values are numbers.
- **Streaming**: To use `db.stream()`, install the `pg-cursor` peer dependency.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
