# SQLite quickstart

This example uses Node's built-in `node:sqlite` API and the packed
`sqlbraid` package's `node:sqlite` adapter. It creates an in-memory database,
so it never mutates a user database.

From the repository root, run the packed release gate:

```bash
pnpm run test:examples
```

The gate packs every SQLBraid package, installs tarballs into a clean temporary
project, then runs the equivalent commands below:

```bash
npm install --save sqlbraid
npm install --save-dev @sqlbraid/cli
npx sqlbraid build --file src/index.ts --out-file build/index.js
node build/index.js
```

The query includes a nullable dynamic guard. `sqlbraid build` lowers that
guard before Node executes the generated JavaScript.
