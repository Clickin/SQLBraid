import * as v from "valibot";
import type { Database } from "sqlbraid";
import { sql } from "sqlbraid/pg";

// The schema maps one database row to one application value. Exact integers arrive
// as strings, so the schema turns them into numbers that are safe for this domain.
export const SafeInteger = v.pipe(v.string(), v.transform(Number), v.integer());

export const BookSchema = v.object({
  id: SafeInteger,
  title: v.string(),
  author: v.string(),
  priceCents: SafeInteger,
  stock: SafeInteger,
});
export type Book = v.InferOutput<typeof BookSchema>;

export interface BookFilter {
  readonly q?: string;
  readonly author?: string;
  readonly maxPriceCents?: number;
  readonly inStockOnly?: boolean;
  readonly sort?: "title" | "price";
}

// Dynamic filters stay inside the SQL. Values are always bound parameters.
export function searchBooks(filter: BookFilter) {
  return sql.rows(BookSchema)`
    SELECT id, title, author, price_cents AS "priceCents", stock
    FROM books
    /*@braid where*/
      /*@braid if ${filter.q !== undefined}*/ AND title ILIKE ${`%${filter.q}%`} /*@braid end*/
      /*@braid if ${filter.author !== undefined}*/ AND author = ${filter.author} /*@braid end*/
      /*@braid if ${filter.maxPriceCents !== undefined}*/ AND price_cents <= ${filter.maxPriceCents} /*@braid end*/
      /*@braid if ${filter.inStockOnly === true}*/ AND stock > 0 /*@braid end*/
    /*@braid end*/
    /*@braid choose*/
      /*@braid when ${filter.sort === "price"}*/ ORDER BY price_cents, id
      /*@braid otherwise*/ ORDER BY title
    /*@braid end*/
  `;
}

// Large results use a stream. The pool lease stays open until the loop ends.
export function streamBooks(db: Database) {
  return db.stream(sql.rows(BookSchema)`
    SELECT id, title, author, price_cents AS "priceCents", stock FROM books ORDER BY id
  `);
}
