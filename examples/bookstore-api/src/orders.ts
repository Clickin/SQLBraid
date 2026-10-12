import * as v from "valibot";
import type { Database } from "sqlbraid";
import { sql } from "sqlbraid/pg";
import { SafeInteger } from "./books.ts";

export interface OrderLine {
  readonly bookId: number;
  readonly quantity: number;
}

export class OutOfStockError extends Error {
  readonly bookId: number;
  constructor(bookId: number) {
    super(`Book ${bookId} is unknown or has too little stock.`);
    this.bookId = bookId;
  }
}

const StockSchema = v.object({ id: SafeInteger, priceCents: SafeInteger, stock: SafeInteger });

// One transaction: lock the books, check the stock, write the order, and reduce the stock.
// Any error rolls back all of it. A throw inside the callback is the rollback signal.
export function placeOrder(db: Database, customer: string, lines: readonly OrderLine[]) {
  return db.tx(async (tx) => {
    // One query locks all rows. The order by id keeps the lock order the same for every request.
    const books = await tx.all(sql.rows(StockSchema)`
      SELECT id, price_cents AS "priceCents", stock FROM books
      WHERE id IN (${sql.list(lines.map((line) => line.bookId))})
      ORDER BY id
      FOR UPDATE
    `);
    const priced = lines.map((line) => {
      const book = books.find((candidate) => candidate.id === line.bookId);
      if (book === undefined || book.stock < line.quantity) throw new OutOfStockError(line.bookId);
      return { ...line, priceCents: book.priceCents };
    });

    const totalCents = priced.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
    const order = await tx.one(sql.rows<{ readonly id: string }>`
      INSERT INTO orders (customer, total_cents) VALUES (${customer}, ${totalCents}) RETURNING id
    `);

    // bulk runs one statement shape with many value sets, on the same connection.
    await tx.bulk(
      priced,
      (line) => sql.command`
        INSERT INTO order_items (order_id, book_id, quantity, price_cents)
        VALUES (${order.id}, ${line.bookId}, ${line.quantity}, ${line.priceCents})
      `,
    );
    await tx.bulk(
      priced,
      (line) => sql.command`UPDATE books SET stock = stock - ${line.quantity} WHERE id = ${line.bookId}`,
    );

    return { orderId: order.id, totalCents };
  });
}
