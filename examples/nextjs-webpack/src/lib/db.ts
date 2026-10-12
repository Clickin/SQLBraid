import "server-only";
import { DatabaseSync } from "node:sqlite";
import { createNodeSqliteDatabase } from "sqlbraid/node-sqlite";

// One in-memory database for the server process. The globalThis cache keeps it
// across hot reloads in development.
const globalForDb = globalThis as typeof globalThis & { sqlbraidExampleDb?: ReturnType<typeof create> };

function create() {
  const native = new DatabaseSync(":memory:");
  native.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      stock INTEGER NOT NULL
    );
    CREATE TABLE stock_log (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products (id),
      amount INTEGER NOT NULL
    );
    INSERT INTO products (name, category, price_cents, stock) VALUES
      ('Espresso beans 1kg', 'coffee', 2400, 12),
      ('Filter paper', 'coffee', 650, 0),
      ('Ceramic mug', 'kitchen', 1500, 40),
      ('Milk jug', 'kitchen', 2100, 3),
      ('Hand grinder', 'coffee', 5900, 7);
  `);
  return createNodeSqliteDatabase(native);
}

export function getDb() {
  return (globalForDb.sqlbraidExampleDb ??= create());
}
