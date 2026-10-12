import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { sql } from "sqlbraid/pg";
import { openDatabase } from "./database.ts";
import { createApp } from "./server.ts";

const connectionString = process.env.SQLBRAID_POSTGRES_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set SQLBRAID_POSTGRES_URL or DATABASE_URL to a PostgreSQL database.");

const { db, close } = await openDatabase(connectionString);
const server = serve({ fetch: createApp(db).fetch, port: 0 });
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
console.info(`Smoke test against ${base}`);

try {
  const titles = async (path: string) =>
    ((await (await fetch(base + path)).json()) as { title: string }[]).map((b) => b.title);
  assert.equal((await titles("/books")).length, 5);
  assert.deepEqual(await titles("/books?author=Fowler"), ["Refactoring"]);
  assert.deepEqual(await titles("/books?q=sql"), ["SQL Performance Explained"]);
  assert.deepEqual(await titles("/books?inStock=true&maxPrice=50&sort=price"), [
    "The Pragmatic Programmer",
    "Refactoring",
  ]);
  const first = ((await (await fetch(`${base}/books?author=Fowler`)).json()) as { priceCents: unknown }[])[0];
  assert.equal(typeof first?.priceCents, "number");

  const post = (body: unknown) =>
    fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await post({
    customer: "Ada",
    lines: [
      { bookId: 1, quantity: 2 },
      { bookId: 4, quantity: 1 },
    ],
  });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as { totalCents: number }).totalCents, 2 * 4200 + 4800);

  // The second line has too little stock. The whole order rolls back, so book 1 keeps its stock.
  const rejected = await post({
    customer: "Grace",
    lines: [
      { bookId: 1, quantity: 1 },
      { bookId: 5, quantity: 3 },
    ],
  });
  assert.equal(rejected.status, 409);
  const stock = await db.one(sql.rows<{ readonly stock: string }>`SELECT stock FROM books WHERE id = ${1}`);
  assert.equal(stock.stock, "8");
  const orders = await db.one(sql.rows<{ readonly count: string }>`SELECT count(*) AS count FROM orders`);
  assert.equal(orders.count, "1");

  assert.equal((await post({ customer: "Ada", lines: [{ bookId: 1, quantity: 0 }] })).status, 400);

  const ndjson = (await (await fetch(`${base}/books.ndjson`)).text()).trim().split("\n");
  assert.equal(ndjson.length, 5);
  console.info("PASS bookstore API: search, order transaction with rollback, NDJSON stream");
} finally {
  server.close();
  await close();
}
