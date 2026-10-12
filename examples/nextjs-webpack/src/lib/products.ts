import "server-only";
import { sql } from "sqlbraid/node-sqlite";
import { getDb } from "./db";

// SQLBraid returns exact integers as strings. The SQL alias sets the key name.
export interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly priceCents: string;
  readonly stock: string;
}

export interface ProductFilter {
  readonly q?: string;
  readonly category?: string;
  readonly maxPriceCents?: number;
  readonly inStockOnly?: boolean;
  readonly sort?: "name" | "price";
}

// The loader lowers the guards. Without it, `filter.q!.trim()` would throw when `q` is missing,
// because plain JavaScript evaluates every `${...}` before it renders the query.
export function findProducts(filter: ProductFilter): Promise<readonly ProductRow[]> {
  return getDb().all(sql.rows<ProductRow>`
    SELECT id, name, category, price_cents AS priceCents, stock
    FROM products
    /*@braid where*/
      /*@braid if ${filter.q !== undefined}*/ AND name LIKE ${`%${filter.q!.trim()}%`} /*@braid end*/
      /*@braid if ${filter.category !== undefined}*/ AND category = ${filter.category} /*@braid end*/
      /*@braid if ${filter.maxPriceCents !== undefined}*/ AND price_cents <= ${filter.maxPriceCents} /*@braid end*/
      /*@braid if ${filter.inStockOnly === true}*/ AND stock > 0 /*@braid end*/
    /*@braid end*/
    /*@braid choose*/
      /*@braid when ${filter.sort === "price"}*/ ORDER BY price_cents, id
      /*@braid otherwise*/ ORDER BY name
    /*@braid end*/
  `);
}

// All statements run on one connection. The transaction rolls back if one fails.
// It returns undefined when the product does not exist.
export function restock(productId: number, amount: number): Promise<ProductRow | undefined> {
  return getDb().tx(async (tx) => {
    const existing = await tx.maybeOne(sql.rows<ProductRow>`
      SELECT id, name, category, price_cents AS priceCents, stock FROM products WHERE id = ${productId}
    `);
    if (existing === undefined) return undefined;
    await tx.execute(sql.command`UPDATE products SET stock = stock + ${amount} WHERE id = ${productId}`);
    await tx.execute(sql.command`INSERT INTO stock_log (product_id, amount) VALUES (${productId}, ${amount})`);
    return tx.one(sql.rows<ProductRow>`
      SELECT id, name, category, price_cents AS priceCents, stock FROM products WHERE id = ${productId}
    `);
  });
}
