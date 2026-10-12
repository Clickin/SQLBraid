import { Hono } from "hono";
import type { Database } from "sqlbraid";
import { searchBooks, streamBooks, type BookFilter } from "./books.ts";
import { OutOfStockError, placeOrder, type OrderLine } from "./orders.ts";

const optional = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

export function createApp(db: Database) {
  const app = new Hono();

  app.get("/books", async (c) => {
    const maxPrice = optional(c.req.query("maxPrice"));
    const filter: BookFilter = {
      q: optional(c.req.query("q")),
      author: optional(c.req.query("author")),
      maxPriceCents: maxPrice === undefined ? undefined : Math.round(Number(maxPrice) * 100),
      inStockOnly: c.req.query("inStock") === "true",
      sort: c.req.query("sort") === "price" ? "price" : "title",
    };
    return c.json(await db.all(searchBooks(filter)));
  });

  // Newline-delimited JSON. Rows leave the database one at a time.
  app.get("/books.ndjson", () => {
    const rows = streamBooks(db)[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await rows.next();
        if (next.done) controller.close();
        else controller.enqueue(new TextEncoder().encode(`${JSON.stringify(next.value)}\n`));
      },
      async cancel() {
        await rows.return?.();
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  });

  app.post("/orders", async (c) => {
    const { customer, lines } = (await c.req.json()) as { customer?: string; lines?: OrderLine[] };
    const valid =
      Array.isArray(lines) &&
      lines.length > 0 &&
      lines.every((line) => Number.isInteger(line.bookId) && Number.isInteger(line.quantity) && line.quantity > 0) &&
      new Set(lines.map((line) => line.bookId)).size === lines.length;
    if (!customer || !valid) {
      return c.json(
        { error: "customer and lines are required. Each line needs a different bookId and a positive quantity." },
        400,
      );
    }
    try {
      return c.json(await placeOrder(db, customer, lines!), 201);
    } catch (error) {
      if (error instanceof OutOfStockError) return c.json({ error: error.message, bookId: error.bookId }, 409);
      throw error;
    }
  });

  return app;
}
