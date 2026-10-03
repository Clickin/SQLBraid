# PostgreSQL example

This example uses the packed `@sqlbraid/postgres` adapter with `pg`. It only
creates a temporary table. It does not change a persistent database.

From the repository root, run the packed release gate. The gate starts a
disposable PostgreSQL Testcontainer. It stops the container during cleanup:

```bash
pnpm run test:examples
```

To use an existing disposable test database, give its URL:

```bash
SQLBRAID_POSTGRES_URL='postgresql://user:password@localhost:5432/db' pnpm run test:examples
```

The installed example runs:

```bash
npm install @sqlbraid/cli @sqlbraid/postgres pg
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```
