# Next.js product catalog

A Next.js App Router application that uses SQLBraid with the `@sqlbraid/webpack` loader.
It has a product list with optional filters and sorting, and an API route that restocks a product in a transaction.
The database is an in-memory `node:sqlite` database that the server fills at start.

## What the example shows

- `src/lib/products.ts` has the SQL. Dynamic filters use `/*@braid ... */` directives. Values are bound parameters.
- The loader lowers the directives. An inactive branch does not evaluate its `${...}` expressions.
  The expression `filter.q!.trim()` would throw when `q` is missing if the loader did not run.
- `src/lib/db.ts` is server-only. It keeps one database for the server process.
- `GET /api/products` and the page at `/` use the same query function.
- `POST /api/restock` uses `db.tx(...)`. The product check, the update and the log insert run on one connection.
- Exact integers are strings (`priceCents: "2400"`). The page converts them for display.
- A SQL alias sets the key name (`price_cents AS priceCents`). SQLBraid does not change names.

## Run it

Use Node.js 22.18 or later.

```sh
npm install
npm run dev          # Webpack
npm run dev:turbopack
```

For a production build:

```sh
npm run build        # next build --webpack
npm run build:turbopack
npm start
```

Open <http://localhost:3000/?category=coffee&inStock=on&sort=price>.

```sh
curl "localhost:3000/api/products?q=mug"
curl -X POST localhost:3000/api/restock -H 'content-type: application/json' -d '{"id":2,"amount":5}'
```

## Bundler configuration

`next.config.mjs` sets the loader for Webpack and for Turbopack. The two settings are separate.
Use `--webpack` or `--turbopack` explicitly. The repository gate builds and runs this example with both.

Next.js checks the original TypeScript source. That check does not know how SQLBraid narrows types inside a directive.
Use `!` or a local variable when a guarded expression reads a nullable value, as in `products.ts`.
Run `sqlbraid check` for the SQLBraid type checks. See the `@sqlbraid/webpack` README for details.

## Test

From the repository root:

```sh
pnpm run test:examples
```

The gate installs this example from packed tarballs, builds it with Webpack and with Turbopack, starts the server
and calls the routes.
