# SQLite quickstart

This example uses the `node:sqlite` API of Node and the `node:sqlite` adapter
of the packed `sqlbraid` package. It creates an in-memory database. It never
changes a user database.

From the repository root, run the packed release gate:

```bash
pnpm run test:examples
```

The gate packs each SQLBraid package and installs the tarballs into a clean
temporary project. Then it runs the equivalent of these commands:

```bash
npm install --save sqlbraid
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

The query has a nullable dynamic guard. `sqlbraid build` lowers that guard
before Node executes the generated JavaScript.
