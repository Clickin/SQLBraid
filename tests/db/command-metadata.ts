import assert from "node:assert/strict";
import type { Database, SqlTag } from "@sqlbraid/core";

export function commandMetadataTitle(transport: string): string {
  return ["metadata.exact-id", "metadata.stale-id", "metadata.affected-rows"]
    .map((scenario) => `[contract:${transport}:${scenario}:integration]`)
    .join(" ");
}

/** The caller creates braid_contract_metadata and reads through a separate physical observer. */
export async function commandMetadataContract(
  db: Database,
  sql: SqlTag,
  committedRows: () => Promise<readonly { readonly id: string; readonly name: string }[]>,
  insertIdFidelity: "lossless" | "guarded" = "lossless",
): Promise<void> {
  const id = "9007199254740993";
  const insert = (value: string) =>
    sql.command`INSERT INTO braid_contract_metadata (id, name) VALUES (${value}, ${"before"})`;
  if (insertIdFidelity === "guarded") {
    await assert.rejects(db.execute(insert(id)), { code: "BRAID_RESULT_EXACTNESS" });
  } else {
    const inserted = await db.execute(insert(id));
    assert.equal(inserted.command.insertId, id);
    assert.equal(inserted.command.affectedRows, 1);
  }
  assert.deepEqual(await committedRows(), [{ id, name: "before" }]);

  const updated = await db.execute(sql.command`UPDATE braid_contract_metadata SET name = ${"after"} WHERE id = ${id}`);
  assert.equal(updated.command.affectedRows, 1);
  assert.deepEqual(await committedRows(), [{ id, name: "after" }]);
  const deleted = await db.execute(sql.command`DELETE FROM braid_contract_metadata WHERE id = ${id}`);
  assert.equal(deleted.command.affectedRows, 1);
  assert.deepEqual(await committedRows(), []);

  const small = await db.execute(insert("7"));
  assert.equal(small.command.insertId, "7");
  assert.equal(small.command.affectedRows, 1);
  assert.deepEqual(await committedRows(), [{ id: "7", name: "before" }]);
  if (insertIdFidelity === "guarded") {
    // Rejection is post-execution, not atomicity: prove each exact bound value was committed.
    await assert.rejects(db.bulk([id], insert), { code: "BRAID_RESULT_EXACTNESS" });
    assert.deepEqual(await committedRows(), [
      { id: "7", name: "before" },
      { id, name: "before" },
    ]);
    await assert.rejects(db.bulk(["9223372036854775807"], insert), { code: "BRAID_RESULT_EXACTNESS" });
  } else {
    const bulk = await db.bulk([id, "9223372036854775807"], insert);
    assert.deepEqual(bulk, { inputCount: 2, affectedRows: 2 });
  }
  assert.deepEqual(await committedRows(), [
    { id: "7", name: "before" },
    { id, name: "before" },
    { id: "9223372036854775807", name: "before" },
  ]);
  const bulkUpdate = await db.bulk(
    ["7", id],
    (value) => sql.command`UPDATE braid_contract_metadata SET name = ${"bulk"} WHERE id = ${value}`,
  );
  assert.deepEqual(bulkUpdate, { inputCount: 2, affectedRows: 2 });
  assert.deepEqual(await committedRows(), [
    { id: "7", name: "bulk" },
    { id, name: "bulk" },
    { id: "9223372036854775807", name: "before" },
  ]);
}
