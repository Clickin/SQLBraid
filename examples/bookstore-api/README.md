# Bookstore REST API

A small REST API on PostgreSQL. It uses Hono for HTTP and SQLBraid for data access.
Node.js runs the TypeScript files directly. There is no build step.

## What the example shows

| File               | Topic                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `migrations/*.sql` | Versioned SQL migrations with `@sqlbraid/migrate`. The server applies them at start.                   |
| `src/books.ts`     | Dynamic search with `/*@braid ... */` directives and Standard Schema row mapping (Valibot).            |
| `src/orders.ts`    | One `db.tx(...)` for an order: row locks, stock check, insert, and `tx.bulk(...)`. A throw rolls back. |
| `src/books.ts`     | `db.stream(...)` for a large result. The route sends newline-delimited JSON.                           |
| `src/database.ts`  | The application creates the `pg` pool. SQLBraid takes one connection for each operation.               |

Rows from the database have string numbers. The Valibot schema in `books.ts` turns them into numbers.

## Run it

Use Node.js 22.18 or later and a PostgreSQL database that you can change. The server creates the tables `books`,
`orders` and `order_items`.

```sh
npm install
export DATABASE_URL=postgres://user:password@localhost:5432/bookstore
npm start
```

```sh
curl "localhost:3000/books?q=sql"
curl "localhost:3000/books?inStock=true&maxPrice=50&sort=price"
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customer":"Ada","lines":[{"bookId":1,"quantity":2}]}'
curl localhost:3000/books.ndjson
```

An order with too little stock returns `409` and changes nothing.

`pg-cursor` is a dependency because `db.stream()` on PostgreSQL needs it.

## Test

`npm run smoke` starts the server on a free port, calls every route, and exits.
It expects an empty database, because it checks the stock and the order count.

From the repository root, `pnpm run test:examples` runs it against a PostgreSQL container with packed tarballs.
