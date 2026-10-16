import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createMigrator } from "@sqlbraid/migrate";
import { loadMigrations } from "@sqlbraid/migrate/node";
import { dialect } from "@sqlbraid/postgres";
import { createPgPoolDatabase } from "@sqlbraid/postgres/pg";

// SQLBraid does not create the pool. The application owns it and closes it.
export async function openDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = createPgPoolDatabase(pool);

  // Apply pending migrations before the server accepts requests.
  // In production, use `mode: "verify"` and apply in a separate deployment step.
  const migrator = createMigrator({
    manifest: await loadMigrations(fileURLToPath(new URL("../migrations", import.meta.url)), {
      dialects: ["postgres"],
    }),
    dialect,
  });
  await migrator.startup(db, { mode: "apply" });

  return { db, close: () => pool.end() };
}
