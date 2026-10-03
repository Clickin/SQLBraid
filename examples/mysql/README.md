# MySQL example

This example uses the packed `@sqlbraid/mysql` adapter with `mysql2`. It only
creates a temporary table. It does not change a persistent database.

From the repository root, run the packed release gate. The gate starts a
disposable MySQL Testcontainer. It stops the container during cleanup:

```bash
pnpm run test:examples
```

To use an existing disposable test database, give its URL:

```bash
SQLBRAID_MYSQL_URL='mysql://user:password@localhost:3306/db' pnpm run test:examples
```

The installed example runs:

```bash
npm install @sqlbraid/cli @sqlbraid/mysql mysql2
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```
