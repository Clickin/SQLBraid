# PostgreSQL example

This example uses the packed `@sqlbraid/postgres` adapter with `pg`. It only
creates a temporary table, so it does not mutate a persistent database.

From the repository root, run the packed release gate. It starts a disposable
PostgreSQL Testcontainer and stops it during cleanup:

```bash
pnpm run test:examples
```

To use an existing disposable test database instead, provide its URL:

```bash
SQLBRAID_POSTGRES_URL='postgresql://user:password@localhost:5432/db' pnpm run test:examples
```

The installed example runs:

```bash
npm install @sqlbraid/cli @sqlbraid/postgres pg
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```
