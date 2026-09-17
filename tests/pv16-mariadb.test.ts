import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  MariaDbConnectionLike,
  MariaDbFieldLike,
  MariaDbQueryOptions,
  MariaDbStreamLike,
} from "@sqlbraid/mariadb/mariadb";
import type { RenderedBulk } from "@sqlbraid/core";
import { createMariaDbExecutor, createMariaDbPoolProvider, mariaDbStatementBinding } from "@sqlbraid/mariadb/mariadb";
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

function queryText(request: string | MariaDbQueryOptions): string {
  return typeof request === "string" ? request : request.sql;
}

test("MariaDB adapter uses metadata to distinguish row and command results", async () => {
  const rows = rowSet(
    [{ id: 1, amount: "12.50" }],
    [
      { name: "id", type: "LONG" },
      { name: "amount", type: "NEWDECIMAL" },
    ],
  );
  const executor = createMariaDbExecutor(connectionFor(rows));
  assert.deepEqual(await executor.query(sql.rows`SELECT 1`.render()), {
    kind: "rows",
    rows: [{ id: "1", amount: "12.50" }],
    rowCount: 1,
  });

  const command = createMariaDbExecutor(connectionFor({ affectedRows: 2, insertId: 9n, warningStatus: 1 }));
  assert.deepEqual(await command.query(sql.command`UPDATE t SET id = 1`.render()), {
    kind: "command",
    rows: [],
    rowCount: 2,
    command: { affectedRows: 2, insertId: "9", warningStatus: 1 },
  });
});

test("MariaDB array rows preserve hostile labels and reject duplicate metadata", async () => {
  const fields = [{ name: "__proto__" }, { name: "constructor" }, { name: "prototype" }] as const;
  const rows = rowSet([["proto", "ctor", "prototype"] as unknown as Record<string, unknown>], fields);
  const result = await createMariaDbExecutor(connectionFor(rows)).query(sql.rows`SELECT 1`.render());
  const row = result.rows[0] as Record<string, unknown>;
  assert.equal(Object.hasOwn(row, "__proto__"), true);
  assert.equal(Object.hasOwn(row, "constructor"), true);
  assert.equal(row["__proto__"], "proto");
  assert.equal(row.constructor, "ctor");
  assert.equal(row.prototype, "prototype");

  const duplicate = rowSet(
    [["first", "second"] as unknown as Record<string, unknown>],
    [{ name: "__proto__" }, { name: "__proto__" }],
  );
  await assert.rejects(
    async () => await createMariaDbExecutor(connectionFor(duplicate)).query(sql.rows`SELECT 1`.render()),
    /duplicate MariaDB result label __proto__/u,
  );
});

test("MariaDB pool discard never releases a poisoned connection", async () => {
  let releases = 0;
  const connection = {
    ...connectionFor(undefined),
    release() {
      releases += 1;
    },
  };
  const provider = createMariaDbPoolProvider({ getConnection: async () => connection });
  const lease = await provider.acquire();
  await assert.rejects(
    async () => lease.release({ discard: true }),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_RESOURCE_CLEANUP",
  );
  assert.equal(releases, 0);
});

test("MariaDB validates transaction options before beginTransaction", async () => {
  let begins = 0;
  const executor = createMariaDbExecutor({
    ...connectionFor(undefined),
    beginTransaction: async () => {
      begins += 1;
    },
  });
  await assert.rejects(
    async () => executor.begin!({ isolation: "invalid" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ readOnly: "yes" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ unsupported: true } as never),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.equal(begins, 0);
});

test("MariaDB adapter rejects ordinary multi-result queries but exposes CALL sets", async () => {
  const sets = [
    rowSet([{ id: 1 }], [{ name: "id", type: "LONG" }]),
    rowSet([{ id: 2 }], [{ name: "id", type: "LONG" }]),
  ];
  const executor = createMariaDbExecutor(connectionFor(sets));
  await assert.rejects(
    async () => await executor.query(sql.rows`CALL returns_sets()`.render()),
    /BRAID_RESULT_SETS_UNSUPPORTED/u,
  );
  assert.deepEqual(await executor.call(sql.call`CALL returns_sets()`.render()), {
    output: {},
    resultSets: [
      { rows: [{ id: "1" }], source: { kind: "emitted", index: 0 } },
      { rows: [{ id: "2" }], source: { kind: "emitted", index: 1 } },
    ],
  });
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
      next: async () =>
        this.index < this.rows.length
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
    assert.deepEqual(row, { id: "1" });
    break;
  }
  assert.equal(source?.closeCount, 1);
});

test("MariaDB stream cleanup closes exactly once after iterator initialization failure", async () => {
  const iteratorError = new Error("iterator initialization failed");
  const closeError = new Error("stream close failed");
  let closeCount = 0;
  const source: MariaDbStreamLike = {
    on(event, listener) {
      if (event === "fields") listener([{ name: "id", type: "LONG" }]);
      return this;
    },
    close() {
      closeCount += 1;
      throw closeError;
    },
    [Symbol.asyncIterator]() {
      throw iteratorError;
    },
  };
  const connection = connectionFor(undefined);
  connection.queryStream = () => source;
  const executor = createMariaDbExecutor(connection);
  await assert.rejects(
    async () => {
      for await (const _row of executor.stream(sql.rows`SELECT id FROM t`.render())) {
        void _row;
      }
    },
    (error: unknown) => {
      const candidate = error as { readonly code?: string; readonly errors?: readonly unknown[] };
      return (
        candidate.code === "BRAID_RESOURCE_CLEANUP" &&
        candidate.errors?.[0] === iteratorError &&
        candidate.errors?.[1] === closeError
      );
    },
  );
  assert.equal(closeCount, 1);
});

test("MariaDB stream abort destroys the connection exactly once", async () => {
  const abortError = new Error("stream abort");
  let destroys = 0;
  const source: MariaDbStreamLike = {
    on(event, listener) {
      if (event === "fields") listener([{ name: "id", type: "LONG" }]);
      return this;
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      yield [1];
      await Promise.resolve();
      yield [2];
    },
  };
  const connection = {
    ...connectionFor(undefined),
    destroy() {
      destroys += 1;
    },
    queryStream() {
      return source;
    },
  };
  const controller = new AbortController();
  const executor = createMariaDbExecutor(connection);
  await assert.rejects(
    async () => {
      for await (const _row of executor.stream(sql.rows`SELECT id FROM t`.render(), undefined, {
        signal: controller.signal,
      })) {
        controller.abort(abortError);
        void _row;
      }
    },
    (error: unknown) =>
      (error as { readonly code?: string; readonly cause?: unknown }).code === "BRAID_RESOURCE_CLEANUP" &&
      (error as { readonly cause?: unknown }).cause === abortError,
  );
  assert.equal(destroys, 1);
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
    statement: sql.command`INSERT INTO t (id) VALUES (${"9007199254740993"})`.render(),
    parameterSets: [["9007199254740993"], ["9007199254740994"], ["9007199254740995"]],
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
  assert.deepEqual(batchValues, [["9007199254740993"], ["9007199254740994"], ["9007199254740995"]]);
});

test("MariaDB adapter rejects unsafe command counts and preserves exact IDs", async () => {
  const unsafe = createMariaDbExecutor(connectionFor({ affectedRows: 9007199254740992n }));
  await assert.rejects(
    async () => unsafe.query(sql.command`DELETE FROM t`.render()),
    /safe non-negative|exact integer/u,
  );
  const unsafeId = createMariaDbExecutor(connectionFor({ affectedRows: 1, insertId: 9007199254740992 }));
  await assert.rejects(
    async () => unsafeId.query(sql.command`INSERT INTO t VALUES (1)`.render()),
    /safe non-negative|exact integer/u,
  );
  const connection = connectionFor({ affectedRows: 0 });
  connection.batch = async () => ({ affectedRows: "9007199254740992" });
  const executor = createMariaDbExecutor(connection);
  const bulk: RenderedBulk = {
    statement: sql.command`DELETE FROM t WHERE id = ${1}`.render(),
    parameterSets: [[1]],
  };
  const binding = mariaDbStatementBinding.describeBulk!(bulk, { dialectId: "mariadb", requestedReuse: "auto" });
  await assert.rejects(async () => executor.bulk!(bulk, binding), /safe non-negative|exact integer/u);
});

test("MariaDB inspector emits first-party metadata identities and rejects non-MariaDB servers", async () => {
  const connection: MariaDbConnectionLike = {
    execute: async (request) => {
      const text = queryText(request);
      if (text.includes("@@version AS version"))
        return [
          {
            version: "11.4.2-MariaDB",
            product: "MariaDB Server",
            sqlMode: "",
            charset: "utf8mb4",
            collation: "utf8mb4_general_ci",
          },
        ];
      if (text.includes("information_schema.schemata")) return [{ schema_name: "app" }];
      if (text.includes("information_schema.tables"))
        return [{ table_schema: "app", table_name: "users", table_type: "BASE TABLE" }];
      if (text.includes("information_schema.columns")) {
        return [
          {
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
          },
        ];
      }
      return [
        {
          routine_schema: "app",
          routine_name: "find_user",
          routine_type: "FUNCTION",
          data_type: "bigint",
          dtd_identifier: "BIGINT",
          is_deterministic: "YES",
          sql_data_access: "READS SQL DATA",
        },
      ];
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
    execute: async (request: string | MariaDbQueryOptions) =>
      queryText(request).includes("@@version AS version") ? [{ version: "8.4.0", product: "MySQL Community" }] : [],
  };
  await assert.rejects(() => createMariaDbInspector(wrongProduct).inspect(), /MARIADB_PRODUCT_UNSUPPORTED/u);
});

test("MariaDB validates transaction options before control SQL", async () => {
  let executions = 0;
  const connection = connectionFor(undefined);
  connection.execute = async () => {
    executions += 1;
    return [];
  };
  const executor = createMariaDbExecutor(connection);
  await assert.rejects(
    async () => executor.begin!({ isolation: "invalid" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  await assert.rejects(
    async () => executor.begin!({ readOnly: "yes" as never }),
    (error: unknown) =>
      error instanceof TypeError && (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
  assert.equal(executions, 0);
});

test("MariaDB rejects active cancellation before execution without destroy support", async () => {
  let executions = 0;
  const connection = connectionFor(undefined);
  connection.execute = async () => {
    executions += 1;
    return [];
  };
  const executor = createMariaDbExecutor(connection);
  const controller = new AbortController();
  await assert.rejects(
    async () => executor.query(sql`SELECT 1`.render(), undefined, { signal: controller.signal }),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_CANCEL_UNSUPPORTED",
  );
  assert.equal(executions, 0);
});

test("MariaDB pre-aborted executions preserve a null AbortSignal reason", async () => {
  let executions = 0;
  const connection = connectionFor(undefined);
  connection.execute = async () => {
    executions += 1;
    return [];
  };
  const executor = createMariaDbExecutor(connection);
  await assert.rejects(
    async () => executor.query(sql`SELECT 1`.render(), undefined, { signal: AbortSignal.abort(null) }),
    (error: unknown) => error === null,
  );
  assert.equal(executions, 0);
});
