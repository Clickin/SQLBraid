import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  MariaDbConnectionLike,
  MariaDbFieldLike,
  MariaDbStreamLike,
} from "@sqlbraid/mariadb/mariadb";
import type { RenderedBulk } from "@sqlbraid/core";
import { createMariaDbExecutor, mariaDbStatementBinding } from "@sqlbraid/mariadb/mariadb";
import { createMariaDbInspector } from "@sqlbraid/mariadb/inspector";
import { sql } from "@sqlbraid/mariadb";

function rowSet(rows: readonly Record<string, unknown>[], meta: readonly MariaDbFieldLike[]) {
  const value = [...rows] as Record<string, unknown>[] & { readonly meta?: readonly MariaDbFieldLike[] };
  Object.defineProperty(value, "meta", { configurable: false, enumerable: false, value: meta });
  return value;
}

function connectionFor(result: unknown): MariaDbConnectionLike {
  return {
    execute: async () => result,
    batch: async () => ({ affectedRows: 0 }),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
}

test("MariaDB adapter uses metadata to distinguish row and command results", async () => {
  const rows = rowSet(
    [{ id: 1, amount: "12.50" }],
    [{ name: "id", type: "LONG" }, { name: "amount", type: "NEWDECIMAL" }],
  );
  const executor = createMariaDbExecutor(connectionFor(rows));
  assert.deepEqual(await executor.query(sql.rows`SELECT 1`.render()), {
    kind: "rows",
    rows: [{ id: 1, amount: "12.50" }],
    rowCount: 1,
  });

  const command = createMariaDbExecutor(connectionFor({ affectedRows: 2, insertId: 9n, warningStatus: 1 }));
  assert.deepEqual(await command.query(sql.command`UPDATE t SET id = 1`.render()), {
    kind: "command",
    rows: [],
    rowCount: 2,
    command: { affectedRows: 2, insertId: 9n, warningStatus: 1 },
  });
});

test("MariaDB adapter rejects ordinary multi-result queries but exposes CALL sets", async () => {
  const sets = [
    rowSet([{ id: 1 }], [{ name: "id", type: "LONG" }]),
    rowSet([{ id: 2 }], [{ name: "id", type: "LONG" }]),
  ];
  const executor = createMariaDbExecutor(connectionFor(sets));
  await assert.rejects(
    () => executor.query(sql.rows`CALL returns_sets()`.render()),
    /BRAID_RESULT_SETS_UNSUPPORTED/u,
  );
  assert.deepEqual(
    await executor.call(sql.call`CALL returns_sets()`.render()),
    {
      output: {},
      resultSets: [
        { rows: [{ id: 1 }], source: { kind: "emitted", index: 0 } },
        { rows: [{ id: 2 }], source: { kind: "emitted", index: 1 } },
      ],
    },
  );
});

class FakeStream implements MariaDbStreamLike {
  private index = 0;
  closeCount = 0;

  constructor(
    private readonly rows: readonly unknown[],
    private readonly fields: readonly MariaDbFieldLike[],
  ) {}

  on(event: string, listener: (...args: readonly unknown[]) => void): this {
    if (event === "fields") listener(this.fields);
    return this;
  }

  close(): void {
    this.closeCount += 1;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async () => this.index < this.rows.length
        ? { done: false, value: this.rows[this.index++] }
        : { done: true, value: undefined },
    };
  }
}

test("MariaDB adapter closes queryStream on consumer break", async () => {
  let source: FakeStream | undefined;
  const connection = connectionFor(undefined);
  connection.queryStream = () => {
    source = new FakeStream([{ id: 1 }, { id: 2 }], [{ name: "id", type: "LONG" }]);
    return source;
  };
  const executor = createMariaDbExecutor(connection);
  for await (const row of executor.stream(sql.rows`SELECT id FROM t`.render())) {
    assert.deepEqual(row, { id: 1 });
    break;
  }
  assert.equal(source?.closeCount, 1);
});

test("MariaDB adapter sends one parameterized SQL shape to native batch", async () => {
  let batchSql = "";
  let batchValues: readonly (readonly unknown[])[] = [];
  const connection = connectionFor({ affectedRows: 0 });
  connection.batch = async (text, values) => {
    batchSql = text;
    batchValues = values;
    return { affectedRows: values.length };
  };
  const executor = createMariaDbExecutor(connection);
  const bulk = {
    statement: sql.command`INSERT INTO t (id) VALUES (${1})`.render(),
    parameterSets: [[1], [2], [3]],
  } as unknown as RenderedBulk;
  const binding = mariaDbStatementBinding.describeBulk!(bulk, {
    dialectId: "mariadb",
    requestedReuse: "auto",
  });
  assert.deepEqual(await executor.bulk?.(bulk, binding), {
    inputCount: 3,
    affectedRows: 3,
    executionMode: "native-bulk",
  });
  assert.equal(batchSql, "INSERT INTO t (id) VALUES (?)");
  assert.deepEqual(batchValues, [[1], [2], [3]]);
});

test("MariaDB inspector emits first-party metadata identities and rejects non-MariaDB servers", async () => {
  const connection: MariaDbConnectionLike = {
    execute: async (text) => {
      if (text.includes("@@version AS version")) return [{ version: "11.4.2-MariaDB", product: "MariaDB Server", sqlMode: "", charset: "utf8mb4", collation: "utf8mb4_general_ci" }];
      if (text.includes("information_schema.schemata")) return [{ schema_name: "app" }];
      if (text.includes("information_schema.tables")) return [{ table_schema: "app", table_name: "users", table_type: "BASE TABLE" }];
      if (text.includes("information_schema.columns")) {
        return [{
          table_schema: "app",
          table_name: "users",
          ordinal_position: 1,
          column_name: "id",
          data_type: "bigint",
          is_nullable: "NO",
          extra: "auto_increment",
          column_key: "PRI",
          generation_expression: null,
          character_set_name: null,
          collation_name: null,
          column_default: null,
        }];
      }
      return [{ routine_schema: "app", routine_name: "find_user", routine_type: "FUNCTION", data_type: "bigint", dtd_identifier: "BIGINT", is_deterministic: "YES", sql_data_access: "READS SQL DATA" }];
    },
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  const snapshot = await createMariaDbInspector(connection).inspect();
  assert.equal(snapshot.dialect, "mariadb");
  assert.equal(snapshot.relations["app.users"]?.columns[0]?.identity, true);
  assert.equal(snapshot.routines.find_user?.[0]?.argumentsComplete, false);
  const wrongProduct = {
    ...connection,
    execute: async (text: string) => text.includes("@@version AS version")
      ? [{ version: "8.4.0", product: "MySQL Community" }]
      : [],
  };
  await assert.rejects(() => createMariaDbInspector(wrongProduct).inspect(), /MARIADB_PRODUCT_UNSUPPORTED/u);
});
