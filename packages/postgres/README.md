# @sqlbraid/postgres

PostgreSQL dialect and `pg` adapters for SQLBraid.

```sh
npm install @sqlbraid/postgres pg
```

Use this package through the `@sqlbraid/postgres/pg` adapter. Give it a connected `pg` client or pool.

### Neon (WebSocket)

Use the `@sqlbraid/postgres/neon` adapter with a `Pool` or `Client` from `@neondatabase/serverless`. Set `neonConfig.webSocketConstructor` first. The adapter is tested against a local WebSocket proxy, so its support label is Compatible. The pooled Neon endpoint can reject named prepared statements, so `statement.prepare` is `guarded` for this adapter.

```ts
import { Pool } from "@neondatabase/serverless";
import { createNeonPoolDatabase } from "@sqlbraid/postgres/neon";

const db = createNeonPoolDatabase(new Pool({ connectionString: process.env.DATABASE_URL }));
```

### Key Details

- **Numerics**: Exact integers and numeric results are strings. Floating-point values are numbers.
- **Streaming**: To use `db.stream()`, install the `pg-cursor` peer dependency.

See the [SQLBraid documentation](https://clickin.github.io/SQLBraid/) for details.
