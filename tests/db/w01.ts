import { expect } from "vitest";

interface DatabaseLike {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(callback: (database: DatabaseLike) => Promise<T>): Promise<T>;
}

interface SqlTagLike {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): unknown;
}

interface W01Options {
  readonly db: DatabaseLike;
  readonly secondaryDb?: DatabaseLike;
  readonly sql: SqlTagLike;
  readonly rows: () => Promise<readonly string[]>;
  readonly clear: () => Promise<void>;
}

const tick = async (): Promise<void> => {
  const ready = Promise.withResolvers<void>();
  setImmediate(ready.resolve);
  await ready.promise;
};

export async function runW01(options: W01Options): Promise<void> {
  const { db, secondaryDb = db, sql, rows, clear } = options;
  await db.execute(sql`DROP TABLE IF EXISTS braid_w01`);
  await db.execute(sql`CREATE TABLE braid_w01 (id VARCHAR(255) PRIMARY KEY)`);

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rollback = db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"A"})`);
    started.resolve();
    await release.promise;
    throw new Error("rollback A");
  });
  await started.promise;
  const outside = secondaryDb.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"B"})`);
  await tick();
  release.resolve();
  await expect(rollback).rejects.toThrow("rollback A");
  await outside;
  const isolatedRows = await rows();
  console.info(`[w01] native observer after rollback race=${JSON.stringify(isolatedRows)}`);
  expect(isolatedRows).toEqual(["B"]);

  await clear();
  const first = db.transaction(async (tx) => { await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"C"})`); });
  const second = db.transaction(async (tx) => { await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"D"})`); });
  await Promise.all([first, second]);
  expect(await rows()).toEqual(["C", "D"]);

  await clear();
  const parentStarted = Promise.withResolvers<void>();
  const parentRelease = Promise.withResolvers<void>();
  const parent = db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"E"})`);
    parentStarted.resolve();
    await parentRelease.promise;
  });
  await parentStarted.promise;
  let outsideSettled = false;
  const waitingOutside = db.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"F"})`).finally(() => { outsideSettled = true; });
  await tick();
  expect(outsideSettled).toBe(false);
  parentRelease.resolve();
  await parent;
  await waitingOutside;
  expect(await rows()).toEqual(["E", "F"]);

  await clear();
  await db.transaction(async (tx) => {
    await tx.transaction(async (nested) => { await nested.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"G"})`); });
    await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"H"})`);
  });
  expect(await rows()).toEqual(["G", "H"]);

  await clear();
  await db.transaction(async (tx) => {
    await expect(tx.transaction(async (nested) => {
      await nested.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"I"})`);
      throw new Error("rollback savepoint");
    })).rejects.toThrow("rollback savepoint");
    await tx.execute(sql`INSERT INTO braid_w01 (id) VALUES (${"J"})`);
  });
  expect(await rows()).toEqual(["J"]);

  await clear();
  let leaked: DatabaseLike | undefined;
  await db.transaction(async (tx) => { leaked = tx; });
  await expect(leaked!.execute(sql`SELECT 1`)).rejects.toMatchObject({ code: "BRAID_TX_CLOSED" });

  await clear();
  await expect(db.transaction(async () => db.execute(sql`SELECT 1`))).rejects.toMatchObject({ code: "BRAID_TX_SCOPE" });
  expect(await rows()).toEqual([]);

  await clear();
  await expect(db.transaction(async (tx) => tx.execute(sql`INSERT INTO braid_w01 (missing) VALUES (${"K"})`))).rejects.toThrow();
  expect(await rows()).toEqual([]);
}
