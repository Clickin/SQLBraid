import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { sql } from '@sqlbraid/sqlite';
import { createNodeSqliteDatabase } from '@sqlbraid/sqlite/node-sqlite';
export async function execute() {
  const native = new DatabaseSync(':memory:');
  try {
    const db = createNodeSqliteDatabase(native);
    return await db.execute(sql.rows<{ value: string }>`SELECT 42 AS value /*@braid if ${false}*/ WHERE value = ${(() => { throw new Error('server inactive'); })()} /*@braid end*/`);
  } finally { native.close(); }
}
