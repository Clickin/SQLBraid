import assert from "node:assert/strict";
import { test } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  BetterSqlite3DatabaseLike,
  BetterSqlite3StatementLike,
} from "../../../packages/sqlite/src/better-sqlite3.js";
import {
  createBetterSqlite3Database,
  createBetterSqlite3Executor,
} from "../../../packages/sqlite/src/better-sqlite3.js";
import { UnsupportedFeatureError } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";

type FakeRow = Record<string, unknown>;

class FakeStatement implements BetterSqlite3StatementLike {
  readonly safeIntegerModes: boolean[] = [];
  readonly runValues: unknown[][] = [];
  readonly iterateReturns: { count: number; returns: number } = { count: 0, returns: 0 };

  constructor(
    private readonly labels: readonly { readonly name: string }[],
    private readonly rows: readonly FakeRow[],
    private readonly runResult: { readonly changes?: number | bigint; readonly lastInsertRowid?: number | bigint } = {
      changes: 1n,
      lastInsertRowid: 9007199254740993n,
    },
  ) {}

  columns(): readonly { readonly name: string }[] {
    return this.labels;
  }

  safeIntegers(enabled = true): this {
    this.safeIntegerModes.push(enabled);
    return this;
  }

  all(..._values: readonly unknown[]): readonly FakeRow[] {
    return this.rows;
  }

  run(...values: readonly unknown[]): { readonly changes?: number | bigint; readonly lastInsertRowid?: number | bigint } {
    this.runValues.push([...values]);
    return this.runResult;
  }

  iterate(..._values: readonly unknown[]): IterableIterator<FakeRow> {
    let index = 0;
    const rows = this.rows;
    const stats = this.iterateReturns;
    return {
      next() {
        if (index >= rows.length) return { done: true, value: undefined };
        const value = rows[index];
        index += 1;
        stats.count += 1;
        return { done: false, value };
      },
      return() {
        index = rows.length;
        stats.returns += 1;
        return { done: true, value: undefined };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }
}

class FakeDatabase implements BetterSqlite3DatabaseLike {
  readonly preparedSql: string[] = [];
  readonly executedSql: string[] = [];
  readonly statements: FakeStatement[] = [];

  prepare(text: string): BetterSqlite3StatementLike {
    this.preparedSql.push(text);
    const statement = text.includes("duplicate")
      ? new FakeStatement([{ name: "duplicate" }, { name: "duplicate" }], [{ duplicate: 2n }])
      : text.includes("WHERE 0")
        ? new FakeStatement([{ name: "value" }], [])
        : text.includes("stream")
          ? new FakeStatement([{ name: "value" }], [{ value: 1n }, { value: 2n }])
          : text.includes("mapped")
            ? new FakeStatement([{ name: "value" }], [{ value: "mapped" }])
            : text.startsWith("SELECT")
              ? new FakeStatement(
                [{ name: "integer" }, { name: "real" }, { name: "bytes" }],
                [{ integer: 9007199254740993n, real: 1, bytes: Uint8Array.from([0, 255]) }],
              )
              : new FakeStatement([], []);
    this.statements.push(statement);
    return statement;
  }

  exec(text: string): void {
    this.executedSql.push(text);
  }
}

test("better-sqlite3 uses statement-local safe integers and preserves SQLite result kinds", async () => {
  const native = new FakeDatabase();
  const db = createBetterSqlite3Database(native);

  assert.deepEqual(
    await db.all(sql.rows`SELECT integer, real, bytes`),
    [{ integer: "9007199254740993", real: 1, bytes: Uint8Array.from([0, 255]) }],
  );
  assert.deepEqual(await db.all(sql.rows`SELECT value WHERE 0`), []);
  assert.equal(native.statements[0]?.safeIntegerModes[0], true);
  assert.equal(native.statements[1]?.safeIntegerModes[0], true);
  assert.deepEqual(
    await db.execute(sql`INSERT INTO values_table (value) VALUES (${1})`),
    {
      rows: [],
      rowCount: 1,
      kind: "command",
      command: { affectedRows: 1, insertId: "9007199254740993" },
    },
  );
  assert.equal(native.statements[2]?.safeIntegerModes[0], true);
  await assert.rejects(() => db.execute(sql`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/);
  await assert.rejects(
    () => db.execute(sql.command`INSERT INTO values_table (value) VALUES (${new Uint8Array([1])})`),
    /BRAID_BIND_VALUE_UNSUPPORTED/,
  );
});

test("better-sqlite3 async mapping, prepared bulk, and explicit transaction controls stay on one handle", async () => {
  const native = new FakeDatabase();
  const db = createBetterSqlite3Database(native);
  const mapper: StandardSchemaV1<unknown, string> = {
    "~standard": {
      version: 1,
      vendor: "better-sqlite3-test",
      async validate(value) {
        return { value: String((value as { readonly value: string }).value).toUpperCase() };
      },
    },
  };

  assert.equal(await db.one(sql.rows(mapper)`SELECT mapped`), "MAPPED");
  const bulk = await db.bulk(["Ada", "Grace"], (name) => sql.command`INSERT INTO names (name) VALUES (${name})`);
  assert.deepEqual(bulk, { inputCount: 2, affectedRows: 2 });
  assert.equal(native.preparedSql.filter((text) => text.startsWith("INSERT INTO names")).length, 1);

  await db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO names (name) VALUES (${"outer"})`);
    await tx.tx(async (nested) => {
      await nested.execute(sql.command`INSERT INTO names (name) VALUES (${"nested"})`);
    });
  });
  assert.equal(native.executedSql[0], "BEGIN");
  assert.match(native.executedSql[1] ?? "", /^SAVEPOINT braid_sp_/u);
  assert.equal(native.executedSql[2], `RELEASE SAVEPOINT ${native.executedSql[1]?.slice("SAVEPOINT ".length)}`);
  assert.equal(native.executedSql[3], "COMMIT");

  const failed = new Error("transaction callback failed");
  await assert.rejects(() => db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO names (name) VALUES (${"rollback"})`);
    throw failed;
  }), (error) => error === failed);
  assert.equal(native.executedSql.at(-1), "ROLLBACK");
});

test("better-sqlite3 streams native iteration with cleanup and rejects unsupported capabilities", async () => {
  const native = new FakeDatabase();
  const db = createBetterSqlite3Database(native);
  const iterator = db.stream(sql.rows`SELECT stream`);
  for await (const row of iterator) {
    assert.deepEqual(row, { value: "1" });
    break;
  }
  assert.equal(native.statements[0]?.iterateReturns.count, 1);
  assert.equal(native.statements[0]?.iterateReturns.returns, 1);

  const signal = new AbortController();
  await assert.rejects(
    () => db.execute(sql`SELECT stream`, { signal: signal.signal }),
    (error) => error instanceof UnsupportedFeatureError
      && error.code === "BRAID_CANCEL_UNSUPPORTED",
  );
  await assert.rejects(() => db.call(sql.call`CALL unsupported()`), /BRAID_CALL_UNSUPPORTED/);

  const executor = createBetterSqlite3Executor(native);
  assert.equal(executor.environment?.driver.id, "better-sqlite3");
  assert.equal(executor.environment?.capabilities["session.pinned"]?.status, "guaranteed");
  assert.equal(executor.environment?.capabilities["transaction.savepoint"]?.status, "guaranteed");
});
