import assert from "node:assert/strict";
import { test } from "vitest";
import { createD1Database } from "@sqlbraid/sqlite/d1";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import { sql } from "@sqlbraid/sqlite";

class FakeWasmStatement {
  readonly columnCount: number;
  readonly pointer: number;
  private readonly names: readonly string[];
  private readonly rows: readonly (readonly unknown[])[];
  private offset = -1;
  private finalized = false;
  constructor(pointer: number, names: readonly string[], rows: readonly (readonly unknown[])[]) {
    this.pointer = pointer;
    this.names = names;
    this.rows = rows;
    this.columnCount = names.length;
  }
  bind(..._values: readonly unknown[]): this { return this; }
  step(): boolean {
    if (this.finalized) throw new Error("finalized");
    this.offset += 1;
    return this.offset < this.rows.length;
  }
  stepReset(): this {
    this.step();
    return this.reset();
  }
  reset(): this { this.offset = -1; return this; }
  get(index: number): unknown {
    const value = this.rows[this.offset]?.[index];
    return typeof value === "bigint" ? Number(value) : value;
  }
  valueAt(index: number): unknown { return this.rows[this.offset]?.[index]; }
  getColumnName(index: number): string { return this.names[index]!; }
  finalize(): void { this.finalized = true; }
}

class FakeWasmDatabase {
  prepares = 0;
  readonly executions: string[] = [];
  private nextPointer = 1;
  private readonly statements = new Map<number, FakeWasmStatement>();
  readonly sqlite3 = {
    capi: {
      SQLITE_INTEGER: 1,
      sqlite3_column_type: (pointer: number, column: number): number => {
        const value = this.statements.get(pointer)?.valueAt(column);
        return typeof value === "bigint" ? 1 : 2;
      },
      sqlite3_column_int64: (pointer: number, column: number): bigint => {
        const value = this.statements.get(pointer)?.valueAt(column);
        if (typeof value !== "bigint") throw new Error("expected INTEGER");
        return value;
      },
    },
  };
  prepare(sqlText: string): FakeWasmStatement {
    this.prepares += 1;
    this.executions.push(sqlText);
    const statement = sqlText.startsWith("SELECT")
      ? /\bREAL\b/u.test(sqlText)
        ? new FakeWasmStatement(this.nextPointer++, ["value"], [[1], [0.1]])
        : new FakeWasmStatement(this.nextPointer++, ["value"], [[1n], [2n]])
      : new FakeWasmStatement(this.nextPointer++, [], []);
    this.statements.set(statement.pointer, statement);
    return statement;
  }
  exec(sqlText: string): void { this.executions.push(sqlText); }
  changes(): number { return 1; }
}

test("SQLite WASM uses OO1 prepare, step, reset, finalize, and transactions", async () => {
  const native = new FakeWasmDatabase();
  const db = createSqliteWasmDatabase(native, { sqlite3: native.sqlite3 });
  assert.deepEqual(await db.all(sql.rows<{ value: string }>`SELECT ${1} AS value`), [{ value: "1" }, { value: "2" }]);
  assert.deepEqual(await db.all(sql.rows<{ value: number }>`SELECT CAST(1 AS REAL) AS value`), [{ value: 1 }, { value: 0.1 }]);
  const streamed: string[] = [];
  for await (const entry of db.stream(sql.rows<{ value: string }>`SELECT ${1} AS value`)) streamed.push(entry.value);
  assert.deepEqual(streamed, ["1", "2"]);
  const beforeBulk = native.prepares;
  assert.deepEqual(await db.bulk([1, 2], (value) => sql.command`INSERT INTO values_table(value) VALUES (${value})`), { inputCount: 2, affectedRows: 2 });
  assert.equal(native.prepares - beforeBulk, 1);
  await db.tx(async (tx) => {
    await tx.execute(sql.command`INSERT INTO values_table(value) VALUES (${3})`);
  });
  assert.ok(native.executions.some((text) => text === "BEGIN"));
  assert.ok(native.executions.some((text) => text === "COMMIT"));
});

test("SQLite WASM rejects row reads without initialized CAPI but keeps command-only usage", async () => {
  const native = new FakeWasmDatabase();
  const db = createSqliteWasmDatabase(native);

  await assert.rejects(
    () => db.all(sql.rows`SELECT ${1} AS value`),
    /BRAID_INTEGER_MODE_UNSUPPORTED/,
  );
  const beforeStream = native.prepares;
  await assert.rejects(
    async () => {
      for await (const row of db.stream(sql.rows`SELECT ${1} AS value`)) void row;
    },
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_STREAM_UNSUPPORTED",
  );
  assert.equal(native.prepares, beforeStream);
  assert.deepEqual(await db.execute(sql.command`UPDATE values_table SET value = ${1}`), {
    rows: [],
    rowCount: 1,
    kind: "command",
    command: { affectedRows: 1 },
  });
});

class FakeD1Statement {
  constructor(private readonly sqlText: string, private readonly values: readonly unknown[] = []) {}
  bind(...values: readonly unknown[]): FakeD1Statement { return new FakeD1Statement(this.sqlText, values); }
  async raw(): Promise<readonly (readonly unknown[])[]> {
    if (this.sqlText.startsWith("SELECT")) {
      if (this.sqlText.includes("duplicate")) return [["value", "value"]];
      if (this.sqlText.includes("empty")) return [["value"]];
      return [["value"], [this.values[0] ?? 7]];
    }
    return [];
  }
}

class FakeD1Database {
  prepares = 0;
  batches = 0;
  prepare(sqlText: string): FakeD1Statement { this.prepares += 1; return new FakeD1Statement(sqlText); }
  async batch(statements: readonly FakeD1Statement[]): Promise<readonly { meta: { changes: number } }[]> {
    this.batches += 1;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

test("D1 uses structural raw columns, ordered binds, native batch, and honest unsupported operations", async () => {
  const native = new FakeD1Database();
  const db = createD1Database(native);
  assert.deepEqual(await db.all(sql.rows<{ value: string }>`SELECT ${42} AS value`), [{ value: "42" }]);
  assert.deepEqual(await db.all(sql.rows<{ value: string }>`SELECT ${42} AS empty`), []);
  assert.deepEqual(await db.bulk([1, 2], (value) => sql.command`UPDATE values_table SET value = ${value}`), { inputCount: 2, affectedRows: 2 });
  assert.equal(native.batches, 1);
  await assert.rejects(async () => {
    for await (const row of db.stream(sql.rows`SELECT 1 AS value`)) void row;
  }, /BRAID_STREAM_UNSUPPORTED/);
  await assert.rejects(() => db.tx(async () => undefined), /BRAID_TX_UNSUPPORTED/);
  await assert.rejects(() => db.all(sql.rows`SELECT 1 AS duplicate, 2 AS duplicate`), /BRAID_RESULT_COLUMNS/);
  await assert.rejects(() => db.all(sql.rows`SELECT ${undefined} AS value`), { code: "BRAID_BIND_VALUE_UNSUPPORTED" });
});
