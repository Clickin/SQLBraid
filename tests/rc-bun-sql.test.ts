import assert from "node:assert/strict";
import { test } from "vitest";
import { ResultExactnessError, UnsupportedFeatureError } from "@sqlbraid/core";
import { sql as mariadb } from "@sqlbraid/mariadb";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as postgres } from "@sqlbraid/postgres";
import { sql as sqlite } from "@sqlbraid/sqlite";
import {
  createBunSqlDatabase,
  createBunSqlProvider,
  type BunSqlClient,
  type BunSqlReservedClient,
} from "@sqlbraid/bun-sql";

type Log = {
  readonly kind: "native" | "unsafe";
  readonly text: string;
  readonly values: readonly unknown[];
  readonly lease: number;
  readonly template?: TemplateStringsArray;
  readonly strings?: readonly string[];
  readonly raw?: readonly string[];
};

function immediateQuery<T>(value: T): PromiseLike<T> {
  return Promise.resolve(value);
}

function fakeClient(logs: Log[], releaseCounts: { count: number }): BunSqlClient {
  let leaseSequence = 0;
  const makeReserved = (): BunSqlReservedClient => {
    const lease = ++leaseSequence;
    const client = ((strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<unknown> => {
      const text = strings.join("");
      logs.push({
        kind: "native",
        text,
        values,
        lease,
        template: strings,
        strings: [...strings],
        raw: [...strings.raw],
      });
      const rows = text.startsWith("SELECT")
        ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : (values[0] ?? 1) }]
        : text.startsWith("SHOW")
          ? [{ value: lease }]
          : [];
      return immediateQuery(
        Object.assign(rows, {
          command: text.startsWith("SELECT") || text.startsWith("SHOW") ? "SELECT" : "UPDATE",
          count: rows.length,
          lastInsertRowid: null,
          affectedRows: rows.length,
        }),
      );
    }) as BunSqlReservedClient;
    client.unsafe = <T = unknown>(text: string, values: readonly unknown[] = []): PromiseLike<T> => {
      logs.push({ kind: "unsafe", text, values, lease });
      const rows = text.startsWith("SELECT")
        ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : (values[0] ?? 1) }]
        : text.startsWith("SHOW")
          ? [{ value: lease }]
          : [];
      const result = Object.assign(rows, {
        command: text.startsWith("SELECT") || text.startsWith("SHOW") ? "SELECT" : text.split(" ")[0],
        count: rows.length,
        lastInsertRowid: null,
        affectedRows: rows.length,
      });
      return immediateQuery(result as T);
    };
    client.release = (): void => {
      releaseCounts.count += 1;
    };
    Object.defineProperty(client, "options", { value: { prepare: true } });
    return client;
  };
  const client = ((strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<unknown> => {
    const text = strings.join("");
    logs.push({
      kind: "native",
      text,
      values,
      lease: 0,
      template: strings,
      strings: [...strings],
      raw: [...strings.raw],
    });
    const rows = text.startsWith("SELECT")
      ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : (values[0] ?? 1) }]
      : [];
    return immediateQuery(
      Object.assign(rows, {
        command: text.startsWith("SELECT") ? "SELECT" : text.split(" ")[0],
        count: rows.length,
        lastInsertRowid: null,
        affectedRows: rows.length,
      }),
    );
  }) as BunSqlClient;
  client.unsafe = <T = unknown>(text: string, values: readonly unknown[] = []): PromiseLike<T> => {
    logs.push({ kind: "unsafe", text, values, lease: 0 });
    const rows = text.startsWith("SELECT")
      ? [{ value: text.includes("CAST") ? String(values[0] ?? 1) : (values[0] ?? 1) }]
      : [];
    return immediateQuery(
      Object.assign(rows, {
        command: text.startsWith("SELECT") ? "SELECT" : "UPDATE",
        count: rows.length,
        lastInsertRowid: null,
        affectedRows: rows.length,
      }) as T,
    );
  };
  client.reserve = async () => makeReserved();
  Object.defineProperty(client, "options", { value: { prepare: true } });
  return client;
}

test("Bun.SQL transport keeps user-selected dialects independent", async () => {
  const logs: Log[] = [];
  const releaseCounts = { count: 0 };
  const client = fakeClient(logs, releaseCounts);
  const db = createBunSqlDatabase(client, { dialect: "postgres" });

  const row = await db.one(postgres.rows<{ value: string }>`SELECT CAST(${7} AS TEXT)`);
  assert.deepEqual(row, { value: "7" });
  const native = logs.at(-1);
  assert.equal(native?.kind, "native");
  assert.deepEqual(native?.strings, ["SELECT CAST(", " AS TEXT)"]);
  assert.deepEqual(native?.raw, ["SELECT CAST(", " AS TEXT)"]);
  assert.deepEqual(native?.values, [7]);
  assert.doesNotMatch(native?.text ?? "", /\$1|\?/u);
  await assert.rejects(
    () => db.one(postgres.rows<{ value: number }>`SELECT ${7}`),
    (error: unknown) => error instanceof ResultExactnessError,
  );

  const beforeMismatch = logs.length;
  await assert.rejects(
    () => db.one(mysql.rows<{ value: number }>`SELECT ${7}`),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_DIALECT_MISMATCH",
  );
  assert.equal(logs.length, beforeMismatch, "dialect mismatch must fail before Bun.SQL I/O");
});

test("Bun.SQL rejects ambiguous MySQL byte carriers without decoding PostgreSQL binary", async () => {
  const bytes = new TextEncoder().encode("12345678901234567890.123456789");
  const client = fakeClient([], { count: 0 });
  const mysqlDb = createBunSqlDatabase(client, { dialect: "mysql" });
  await assert.rejects(
    mysqlDb.one(mysql.rows`SELECT ${bytes}`),
    (error: unknown) => error instanceof ResultExactnessError,
  );
  const postgresDb = createBunSqlDatabase(client, { dialect: "postgres" });
  assert.deepEqual(await postgresDb.one(postgres.rows`SELECT ${bytes}`), { value: bytes });
});

test("Bun.SQL reserved connections pin sessions and transactions", async () => {
  const logs: Log[] = [];
  const releaseCounts = { count: 0 };
  const db = createBunSqlDatabase(fakeClient(logs, releaseCounts), { dialect: "mysql" });

  await db.session(async (session) => {
    await session.one(mysql.rows<{ value: string }>`SELECT CAST(${11} AS CHAR)`);
    await session.one(mysql.rows<{ value: string }>`SELECT CAST(${12} AS CHAR)`);
    await session.tx(async (tx) => {
      await tx.execute(mysql.command`UPDATE values SET value = ${13}`);
    });
  });

  assert.equal(new Set(logs.filter((entry) => entry.lease > 0).map((entry) => entry.lease)).size, 1);
  assert.equal(releaseCounts.count, 1);
  assert.ok(logs.some((entry) => entry.kind === "unsafe" && entry.text.startsWith("START TRANSACTION")));
  assert.ok(logs.some((entry) => entry.kind === "unsafe" && entry.text === "COMMIT"));
  assert.ok(
    logs.some((entry) => entry.kind === "native" && entry.strings?.[0] === "SELECT CAST(" && entry.values[0] === 11),
  );
});

test.each([
  { dialect: "postgres", readOnly: undefined, begin: "BEGIN" },
  { dialect: "postgres", readOnly: true, begin: "BEGIN READ ONLY" },
  { dialect: "postgres", readOnly: false, begin: "BEGIN READ WRITE" },
] as const)(
  "[contract:bun-sql-$dialect:transaction.access-mode:boundary] [ownership:pooled] Bun.SQL $dialect preserves readOnly=$readOnly transaction access mode",
  async ({ dialect, readOnly, begin }) => {
    const logs: Log[] = [];
    const db = createBunSqlDatabase(fakeClient(logs, { count: 0 }), { dialect });

    await db.tx({ readOnly }, async () => undefined);

    assert.deepEqual(
      logs.filter((entry) => entry.kind === "unsafe").map((entry) => entry.text),
      [begin, "COMMIT"],
    );
  },
);

test.each(["mysql", "mariadb"] as const)(
  "Bun.SQL %s rejects explicit access modes before acquiring a lease",
  async (dialect) => {
    const logs: Log[] = [];
    const client = fakeClient(logs, { count: 0 });
    let acquired = false;
    client.reserve = async () => {
      acquired = true;
      throw new Error("must not acquire");
    };
    const db = createBunSqlDatabase(client, { dialect });
    for (const readOnly of [true, false]) {
      await assert.rejects(
        db.tx({ readOnly }, async () => assert.fail("unsupported callback must not run")),
        (error: unknown) =>
          error instanceof UnsupportedFeatureError &&
          error.code === "BRAID_TX_OPTION_UNSUPPORTED" &&
          error.feature === "transaction.read-only",
      );
    }
    assert.equal(acquired, false);
    assert.deepEqual(logs, []);
  },
);

test.each(["query", "caught-query", "bulk", "control"] as const)(
  "Bun.SQL read-only contamination from %s discards only after its owning session ends",
  async (path) => {
    const client = fakeClient([], { count: 0 });
    const reserve = client.reserve!;
    const events: string[] = [];
    const failure = Object.assign(new Error("read only"), { errno: 1792, sqlState: "25006" });
    client.reserve = async () => {
      const native = await reserve();
      const unsafe = native.unsafe;
      native.unsafe = <T>(text: string, values?: readonly unknown[]) => {
        events.push(text);
        if (path === "control" && text === "START TRANSACTION") throw failure;
        return unsafe<T>(text, values);
      };
      native.close = async () => {
        events.push("discard");
      };
      native.release = () => {
        events.push("release");
      };
      return new Proxy(native, {
        apply(target, thisArg, args) {
          if (args[0].join("").startsWith("INSERT")) throw failure;
          return Reflect.apply(target, thisArg, args);
        },
      });
    };
    const db = createBunSqlDatabase(client, { dialect: "mysql" });
    await db.session(async (session) => {
      const transaction = session.tx(async (tx) => {
        const write = (value: string) => mysql.command`INSERT INTO values_table VALUES (${value})`;
        if (path === "bulk") await tx.bulk(["A"], write);
        else if (path === "caught-query") await assert.rejects(tx.execute(write("A")), (error) => error === failure);
        else await tx.execute(write("A"));
      });
      if (path === "caught-query") await transaction;
      else await assert.rejects(transaction, (error: unknown) => error === failure);
      assert.ok(!events.includes("discard"), "a statement failure must not close its still-owned session");
      if (path !== "control") assert.ok(events.includes(path === "caught-query" ? "COMMIT" : "ROLLBACK"));
    });
    assert.equal(events.at(-1), "discard");
    assert.equal(events.filter((event) => event === "discard").length, 1);
    assert.ok(!events.includes("release"), "contaminated lease must never return to the pool");
  },
);

test("Bun.SQL ordinary MySQL statement errors do not discard a healthy lease", async () => {
  const client = fakeClient([], { count: 0 });
  const native = await client.reserve!();
  let discarded = false;
  let released = false;
  native.close = async () => {
    discarded = true;
  };
  native.release = () => {
    released = true;
  };
  const failure = Object.assign(new Error("duplicate"), { errno: 1062, sqlState: "23000" });
  client.reserve = async () =>
    new Proxy(native, {
      apply() {
        throw failure;
      },
    });
  const db = createBunSqlDatabase(client, { dialect: "mysql" });
  await assert.rejects(
    db.execute(mysql.command`INSERT INTO values_table VALUES (${"A"})`),
    (error) => error === failure,
  );
  assert.equal(discarded, false);
  assert.equal(released, true);
});

test("Bun.SQL uses stable native templates for bulk and rejects Bun structural helpers", async () => {
  const logs: Log[] = [];
  const client = fakeClient(logs, { count: 0 });
  const db = createBunSqlDatabase(client, { dialect: "sqlite" });
  const prepared = db.prepare("native-prepared", (value: number) => sqlite.command`UPDATE values SET value = ${value}`);
  await prepared.execute(3);
  await prepared.execute(4);
  await db.bulk([1, 2], (value) => sqlite.command`UPDATE values SET value = ${value}`);
  const bulkEntries = logs.filter((entry) => entry.kind === "native");
  assert.equal(bulkEntries.length, 4);
  assert.equal(bulkEntries[0]?.template, bulkEntries[1]?.template);
  assert.equal(bulkEntries[2]?.template, bulkEntries[3]?.template);
  assert.deepEqual(
    bulkEntries.map((entry) => entry.values),
    [[3], [4], [1], [2]],
  );
  const fragment = client`AND value = ${1}`;
  const before = logs.length;
  const helper = { value: [{ id: 1 }], columns: ["id"] };
  await assert.rejects(() => db.one(sqlite.rows`SELECT ${helper}`), /Bun\.SQL structural helper/u);
  assert.equal(logs.length, before);
  await assert.rejects(() => db.one(sqlite.rows`SELECT 1 ${fragment}`), /Bun\.SQL query or fragment/u);
  assert.equal(logs.length, before);
  await assert.rejects(() => db.one(sqlite.rows`SELECT ${{ json: true }}`), /ambiguous Bun\.SQL object value/u);
  assert.equal(logs.length, before);
});

test("Bun.SQL quarantines discard requests without a scoped discard primitive", async () => {
  const releaseCounts = { count: 0 };
  const provider = createBunSqlProvider(fakeClient([], releaseCounts), { dialect: "mysql" });
  const lease = await provider.acquire();
  await assert.rejects(
    async () => lease.release({ discard: true }),
    (error: unknown) =>
      error instanceof UnsupportedFeatureError &&
      error.code === "BRAID_RESOURCE_CLEANUP" &&
      error.feature === "resource.discard",
  );
  await assert.rejects(
    async () => lease.release(),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.feature === "resource.discard",
  );
  assert.equal(releaseCounts.count, 0);
});

test("Bun.SQL exposes explicit unsupported streaming and routine paths", async () => {
  const logs: Log[] = [];
  const db = createBunSqlDatabase(fakeClient(logs, { count: 0 }), { dialect: "mariadb" });
  const stream = db.stream(mariadb.rows<{ value: number }>`SELECT 1`);
  await assert.rejects(
    async () => {
      for await (const _row of stream) {
        /* unreachable */
      }
    },
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_STREAM_UNSUPPORTED",
  );
  await assert.rejects(
    () => db.call(mariadb.call`CALL work()`),
    (error: unknown) => error instanceof UnsupportedFeatureError && error.code === "BRAID_CALL_UNSUPPORTED",
  );
  assert.equal(logs.length, 0, "unsupported operations must fail before statement I/O");
});

test("Bun.SQL SQLite uses one direct physical client and advertises canonical capabilities", async () => {
  const logs: Log[] = [];
  const db = createBunSqlDatabase(fakeClient(logs, { count: 0 }), { dialect: "sqlite" });
  const environment = await db.environment();
  assert.equal(environment.driver.id, "bun-sql");
  assert.equal(environment.capabilities["statement.prepare"]?.status, "guaranteed");
  assert.equal(environment.capabilities["statement.cancel"]?.status, "unsupported");
  assert.equal(environment.capabilities["statement.stream"]?.status, "unsupported");
  assert.equal(environment.capabilities["routine.result-sets"]?.status, "unsupported");
  assert.equal("execution.stream" in environment.capabilities, false);
  await db.execute(sqlite.command`CREATE TABLE t (value INTEGER)`);
  await db.tx({ isolation: "serializable" }, async (tx) => {
    await tx.execute(sqlite.command`INSERT INTO t (value) VALUES (${1})`);
  });
  assert.equal(environment.capabilities["transaction.isolation.serializable"]?.status, "guaranteed");
  assert.ok(logs.some((entry) => entry.kind === "unsafe" && entry.text === "BEGIN"));
  await assert.rejects(
    () => db.tx({ foo: true } as never, async () => undefined),
    (error: unknown) => (error as { readonly code?: string }).code === "BRAID_TX_OPTIONS_INVALID",
  );
});
