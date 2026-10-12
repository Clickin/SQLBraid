import { serve } from "@hono/node-server";
import { openDatabase } from "./database.ts";
import { createApp } from "./server.ts";

const connectionString = process.env.DATABASE_URL ?? process.env.SQLBRAID_POSTGRES_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to a PostgreSQL database.");

const { db, close } = await openDatabase(connectionString);
const server = serve({ fetch: createApp(db).fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.info(`Bookstore API on http://localhost:${info.port}`);
});

// Stop accepting requests, then close the pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => void close());
  });
}
