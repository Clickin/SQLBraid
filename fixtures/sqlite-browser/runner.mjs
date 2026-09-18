import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createStatementBindingDescription } from "@sqlbraid/core";
import { sql } from "@sqlbraid/sqlite";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";

const nativeMarkers = "literal $1 :1 @p1 ?";
const jsonText =
  '{"small":42,"largeInteger":9223372036854775807,"highPrecision":12345678901234567890.12345678901234567890,"nested":{"array":[9007199254740993,0.1000000000000000000001]}}';

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function latestReady(events) {
  const ready = events.findLast((event) => event.type === "query:ready");
  expect(ready !== undefined, "SQLite WASM did not emit query:ready evidence.");
  return ready;
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function serialValue(value) {
  if (value instanceof Uint8Array) return { type: "Uint8Array", value: [...value] };
  return { type: typeof value, value };
}

function database(sqlite3, observers = []) {
  const native = new sqlite3.oo1.DB(":memory:");
  const db = createSqliteWasmDatabase(native, { sqlite3, observers });
  return { native, db };
}

async function nativeTransparency(sqlite3) {
  const events = [];
  const { native, db } = database(sqlite3, [
    {
      onEvent(event) {
        events.push(event);
      },
    },
  ]);
  try {
    const query = sql.rows`
      SELECT 'literal $1 :1 @p1 ?' AS marker,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled,
             ${7} AS actual
    `;
    const rendered = query.render();
    const expectedSegments = [
      "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(",
      ", '$.enabled') AS enabled,\n             ",
      " AS actual\n    ",
    ];
    const expectedParameterizedSql =
      "\n      SELECT 'literal $1 :1 @p1 ?' AS marker,\n             json_extract(?1, '$.enabled') AS enabled,\n             ?2 AS actual\n    ";
    expect(
      JSON.stringify(rendered.segments) === JSON.stringify(expectedSegments),
      "SQLite WASM logical SQL segments changed.",
    );
    const rows = await db.all(query);
    const ready = latestReady(events);
    expect(ready.sql === expectedParameterizedSql, "SQLite WASM observed parameterized SQL changed.");
    expect(
      rows.length === 1 && rows[0].marker === nativeMarkers && rows[0].enabled === "1" && rows[0].actual === "7",
      "SQLite WASM returned an unexpected transparency row.",
    );
    return {
      logicalSegments: rendered.segments,
      parameterizedSql: ready.sql,
      observedValues: ready.values,
      rows,
    };
  } finally {
    native.close();
  }
}

async function generatedStructure(sqlite3) {
  const events = [];
  const { native, db } = database(sqlite3, [
    {
      onEvent(event) {
        events.push(event);
      },
    },
  ]);
  try {
    native.exec("CREATE TABLE generated_table (name TEXT NOT NULL)");
    const insert = sql.command`INSERT INTO ${sql.ident("generated_table")} (${sql.ident("name")}) VALUES (${"Ada"})`;
    const rendered = insert.render();
    const expectedSegments = ['INSERT INTO "generated_table" ("name") VALUES (', ")"];
    const expectedParameterizedSql = 'INSERT INTO "generated_table" ("name") VALUES (?1)';
    expect(
      JSON.stringify(rendered.segments) === JSON.stringify(expectedSegments),
      "SQLite WASM generated identifier structure changed.",
    );
    await db.execute(insert);
    const ready = latestReady(events);
    expect(ready.sql === expectedParameterizedSql, "SQLite WASM generated statement SQL changed.");
    const rows = await db.all(sql.rows`SELECT ${sql.ident("name")} AS name FROM ${sql.ident("generated_table")}`);
    expect(rows.length === 1 && rows[0].name === "Ada", "SQLite WASM generated identifier row was not stored.");
    return { logicalSegments: rendered.segments, parameterizedSql: ready.sql, rows };
  } finally {
    native.close();
  }
}

async function exactInteger(sqlite3) {
  const { native, db } = database(sqlite3);
  try {
    const safe = "9007199254740991";
    const safePlusOne = "9007199254740992";
    const minimum = "-9223372036854775808";
    const maximum = "9223372036854775807";
    const row = await db.one(sql.rows`
      SELECT CAST(${safe} AS INTEGER) AS safe,
             CAST(${safePlusOne} AS INTEGER) AS safe_plus_one,
             CAST(${minimum} AS INTEGER) AS minimum,
             CAST(${maximum} AS INTEGER) AS maximum,
             CAST(1 AS REAL) AS integral_real,
             CAST(1e20 AS REAL) AS large_real
    `);
    const values = {
      safe: serialValue(row.safe),
      safePlusOne: serialValue(row.safe_plus_one),
      minimum: serialValue(row.minimum),
      maximum: serialValue(row.maximum),
    };
    expect(values.safe.type === "string" && values.safe.value === safe, "SQLite WASM safe integer changed.");
    expect(
      values.safePlusOne.type === "string" && values.safePlusOne.value === safePlusOne,
      "SQLite WASM safe-plus-one integer changed.",
    );
    expect(
      values.minimum.type === "string" && values.minimum.value === minimum,
      "SQLite WASM signed int64 minimum changed.",
    );
    expect(
      values.maximum.type === "string" && values.maximum.value === maximum,
      "SQLite WASM signed int64 maximum changed.",
    );
    expect(
      Object.values(values).every((value) => value.type === "string"),
      "SQLite WASM INTEGER values were not returned uniformly as text.",
    );
    const realValues = [serialValue(row.integral_real), serialValue(row.large_real)];
    expect(
      realValues.every((value) => value.type === "number"),
      "SQLite WASM confused integral REAL values with INTEGER.",
    );
    return { values, realValues };
  } finally {
    native.close();
  }
}

async function jsonTextCase(sqlite3) {
  const { native, db } = database(sqlite3);
  try {
    const row = await db.one(sql.rows`
      SELECT ${jsonText} AS payload,
             json_extract(${'{"enabled":true}'}, '$.enabled') AS enabled
    `);
    expect(row.payload === jsonText && row.enabled === "1", "SQLite WASM JSON text row changed.");
    return { rows: [{ payload: row.payload, enabled: row.enabled }] };
  } finally {
    native.close();
  }
}

async function streamCase(sqlite3) {
  const { native, db } = database(sqlite3);
  try {
    const query = sql.rows`
      WITH RECURSIVE numbers(value) AS (
        SELECT 1
        UNION ALL SELECT value + 1 FROM numbers WHERE value < 3
      )
      SELECT value FROM numbers ORDER BY value
    `;
    const iterator = db.stream(query)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done === false && first.value.value === "1", "SQLite WASM stream did not yield its first real row.");
    let blockedCode = "NONE";
    try {
      await db.all(sql.rows`SELECT 99 AS value`);
    } catch (error) {
      blockedCode = errorCode(error);
    }
    expect(blockedCode === "BRAID_STREAM_SCOPE", "SQLite WASM stream did not retain its resource lease.");
    const rest = [];
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- Pull the same cursor sequentially while its lease is held.
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value.value);
    }
    expect(JSON.stringify(rest) === '["2","3"]', "SQLite WASM stream lost rows after its first pull.");
    const after = await db.all(sql.rows`SELECT 4 AS value`);
    expect(
      after.length === 1 && after[0].value === "4",
      "SQLite WASM stream did not release its resource after completion.",
    );
    const early = db.stream(query)[Symbol.asyncIterator]();
    expect((await early.next()).value.value === "1", "SQLite WASM early-return stream did not start.");
    await early.return();
    const afterReturn = await db.all(sql.rows`SELECT 5 AS value`);
    expect(
      afterReturn.length === 1 && afterReturn[0].value === "5",
      "SQLite WASM early iterator return did not release the native resource.",
    );
    return { first: first.value, blockedCode, rows: [first.value.value, ...rest], after, afterReturn };
  } finally {
    native.close();
  }
}

async function bulkCase(sqlite3) {
  let prepareCount = 0;
  const events = [];
  const native = new sqlite3.oo1.DB(":memory:");
  native.exec("CREATE TABLE bulk_values (value INTEGER NOT NULL)");
  const observed = {
    prepare(sqlText) {
      prepareCount += 1;
      return native.prepare(sqlText);
    },
    exec: native.exec.bind(native),
    changes: native.changes.bind(native),
  };
  const db = createSqliteWasmDatabase(observed, {
    sqlite3,
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  try {
    const result = await db.bulk([1, 2, 3], (value) => sql.command`INSERT INTO bulk_values (value) VALUES (${value})`);
    const rows = await db.all(sql.rows`SELECT value FROM bulk_values ORDER BY value`);
    expect(result.inputCount === 3 && result.affectedRows === 3, "SQLite WASM bulk did not report all affected rows.");
    expect(prepareCount === 2, "SQLite WASM bulk did not use one prepared statement for all items.");
    expect(
      JSON.stringify(rows) === JSON.stringify([{ value: "1" }, { value: "2" }, { value: "3" }]),
      "SQLite WASM bulk rows were not stored.",
    );
    const ready = events.find((event) => event.type === "bulk:ready");
    const completed = events.find((event) => event.type === "bulk:result");
    expect(
      ready !== undefined && ready.sql === "INSERT INTO bulk_values (value) VALUES (?1)",
      "SQLite WASM bulk parameterized SQL was not observed.",
    );
    expect(
      completed !== undefined && completed.executionMode === "prepared-loop",
      "SQLite WASM bulk execution mode was not observed.",
    );
    return { result, parameterizedSql: ready.sql, executionMode: completed.executionMode, prepareCount, rows };
  } finally {
    native.close();
  }
}

async function mappedTransaction(sqlite3) {
  const { native, db } = database(sqlite3);
  const schema = {
    "~standard": {
      version: 1,
      vendor: "sqlbraid-browser-fixture",
      validate: (row) => ({
        value: { ...row, name: row.name.toUpperCase(), payload: JSON.parse(row.payload), bytes: [...row.bytes] },
      }),
    },
  };
  try {
    const session = await db.session(async (scoped) => {
      await scoped.execute(sql.command`CREATE TEMP TABLE session_marker (value TEXT NOT NULL)`);
      const prepared = scoped.prepare("session-marker", (value) => sql.rows`SELECT ${value} AS value`);
      const preparedRow = await prepared.one("pinned");
      await scoped.tx({ isolation: "serializable" }, async (tx) => {
        await tx.execute(sql.command`INSERT INTO session_marker VALUES (${"nested"})`);
      });
      const markers = await scoped.all(sql.rows`SELECT value FROM session_marker ORDER BY rowid`);
      return { preparedRow, markers };
    });
    await db.execute(
      sql.command`CREATE TABLE mapped (id INTEGER PRIMARY KEY, name TEXT, payload TEXT, bytes BLOB, stamp TEXT, uuid TEXT)`,
    );
    const inserted = await db.tx(async (tx) => {
      const result = await tx.one(
        sql.rows(
          schema,
        )`INSERT INTO mapped VALUES (1, ${"Ada"}, ${'{"active":true}'}, ${new Uint8Array([0, 128, 255])}, ${"2026-09-14T00:00:00.123456Z"}, ${"123e4567-e89b-12d3-a456-426614174000"}) RETURNING *`,
      );
      const rollback = new Error("rollback nested insert");
      try {
        await tx.tx(async (nested) => {
          await nested.execute(sql.command`INSERT INTO mapped (id, name) VALUES (2, 'discarded')`);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const prepared = tx.prepare("mapped-row", () => sql.rows(schema)`SELECT * FROM mapped WHERE id = ${1}`);
      expect(
        JSON.stringify((await prepared.execute()).rows) === JSON.stringify([result]),
        "SQLite WASM prepared mapping lost the query-bound schema.",
      );
      return result;
    });
    const stored = await db.all(sql.rows`SELECT id FROM mapped ORDER BY id`);
    expect(
      JSON.stringify(stored) === '[{"id":"1"}]',
      "SQLite WASM nested rollback did not preserve only the committed row.",
    );
    const updated = await db.one(sql.rows`UPDATE mapped SET name = ${"Grace"} WHERE id = 1 RETURNING id, name`);
    const deleted = await db.one(sql.rows`DELETE FROM mapped WHERE id = 1 RETURNING id`);
    const remaining = await db.all(sql.rows`SELECT id FROM mapped`);
    return { session, inserted, updated, deleted, remaining };
  } finally {
    native.close();
  }
}

function scopeAdmissionProvider(gate, rejectFirst) {
  const capabilities = {
    "session.pinned": { status: "guaranteed" },
    transaction: { status: "guaranteed" },
    "transaction.savepoint": { status: "guaranteed" },
  };
  const statementBinding = Object.freeze({
    id: "sqlite-browser-scope",
    describe(statement, context) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "sqlite-browser-scope",
        transport: "text-positional",
        placeholder: (index) => `?${index}`,
        reuse: { effective: "simple", owner: "driver" },
      });
    },
  });
  let acquires = 0;
  let first = true;
  const started = Promise.withResolvers();
  return {
    started: started.promise,
    statementBinding,
    environment: {
      database: { product: "sqlite-browser-scope" },
      driver: { id: "sqlite-browser-scope", version: "fixture", profile: "conformance" },
      capabilities,
    },
    get acquires() {
      return acquires;
    },
    async acquire() {
      acquires += 1;
      if (first) {
        first = false;
        started.resolve();
        await gate;
        if (rejectFirst) throw new Error("fixture acquisition failed");
      }
      return {
        statementBinding,
        environment: {
          database: { product: "sqlite-browser-scope" },
          driver: { id: "sqlite-browser-scope", version: "fixture", profile: "conformance" },
          capabilities,
        },
        async query() {
          return { kind: "rows", rows: [] };
        },
        async *stream() {},
        async call() {
          return { output: {}, resultSets: [{ rows: [], source: { kind: "emitted", index: 0 } }] };
        },
        async begin() {},
        async commit() {},
        async rollback() {},
        async savepoint() {},
        async rollbackTo() {},
        async releaseSavepoint() {},
        release() {},
      };
    },
  };
}

async function conservativeScopeAdmission() {
  let sessionResume;
  const sessionGate = new Promise((resolve) => {
    sessionResume = resolve;
  });
  const sessionProvider = scopeAdmissionProvider(sessionGate, false);
  const sessionDb = createPooledDatabase(sessionProvider);
  const sessionFirst = sessionDb.session(async (scoped) => {
    await scoped.execute(sql`SELECT session`);
  });
  await sessionProvider.started;
  let sessionOverlapCode = "NONE";
  try {
    await sessionDb.session(async () => undefined);
  } catch (error) {
    sessionOverlapCode = errorCode(error);
  }
  expect(sessionOverlapCode === "BRAID_SESSION_SCOPE", "Browser session admission allowed overlapping root sessions.");
  expect(
    sessionProvider.acquires === 1,
    "Browser session admission acquired a second lease before the first completed.",
  );
  sessionResume();
  await sessionFirst;
  await sessionDb.execute(sql`SELECT session-after`);
  expect(sessionProvider.acquires === 2, "Browser session admission did not restore root usability after completion.");

  let failedSessionResume;
  const failedSessionGate = new Promise((resolve) => {
    failedSessionResume = resolve;
  });
  const failedSessionProvider = scopeAdmissionProvider(failedSessionGate, true);
  const failedSessionDb = createPooledDatabase(failedSessionProvider);
  const failedSession = failedSessionDb.session(async () => undefined);
  failedSessionResume();
  await failedSession.then(
    () => {
      throw new Error("Browser session acquisition failure was swallowed.");
    },
    (error) => {
      expect(
        error?.message === "fixture acquisition failed",
        "Browser session acquisition failure changed unexpectedly.",
      );
    },
  );
  await failedSessionDb.session(async (scoped) => {
    await scoped.execute(sql`SELECT session-after-failure`);
  });
  expect(
    failedSessionProvider.acquires === 2,
    "Browser session admission left a stale predecessor marker after failure.",
  );

  let transactionResume;
  const transactionGate = new Promise((resolve) => {
    transactionResume = resolve;
  });
  const transactionProvider = scopeAdmissionProvider(transactionGate, false);
  const transactionDb = createPooledDatabase(transactionProvider);
  const transactionFirst = transactionDb.tx(async (tx) => {
    await tx.execute(sql`SELECT transaction`);
  });
  await transactionProvider.started;
  let transactionOverlapCode = "NONE";
  try {
    await transactionDb.tx(async () => undefined);
  } catch (error) {
    transactionOverlapCode = errorCode(error);
  }
  expect(
    transactionOverlapCode === "BRAID_TX_SCOPE",
    "Browser transaction admission allowed overlapping root transactions.",
  );
  expect(
    transactionProvider.acquires === 1,
    "Browser transaction admission acquired a second lease before the first completed.",
  );
  transactionResume();
  await transactionFirst;
  await transactionDb.execute(sql`SELECT transaction-after`);
  expect(
    transactionProvider.acquires === 2,
    "Browser transaction admission did not restore root usability after completion.",
  );

  let failedTransactionResume;
  const failedTransactionGate = new Promise((resolve) => {
    failedTransactionResume = resolve;
  });
  const failedTransactionProvider = scopeAdmissionProvider(failedTransactionGate, true);
  const failedTransactionDb = createPooledDatabase(failedTransactionProvider);
  const failedTransaction = failedTransactionDb.tx(async () => undefined);
  failedTransactionResume();
  await failedTransaction.then(
    () => {
      throw new Error("Browser transaction acquisition failure was swallowed.");
    },
    (error) => {
      expect(
        error?.message === "fixture acquisition failed",
        "Browser transaction acquisition failure changed unexpectedly.",
      );
    },
  );
  await failedTransactionDb.tx(async (tx) => {
    await tx.execute(sql`SELECT transaction-after-failure`);
  });
  expect(
    failedTransactionProvider.acquires === 2,
    "Browser transaction admission left a stale predecessor marker after failure.",
  );

  return {
    session: { overlapCode: sessionOverlapCode, acquires: sessionProvider.acquires },
    sessionFailure: { acquires: failedSessionProvider.acquires },
    transaction: { overlapCode: transactionOverlapCode, acquires: transactionProvider.acquires },
    transactionFailure: { acquires: failedTransactionProvider.acquires },
  };
}

async function run() {
  expect(typeof WebAssembly === "object", "SQLite WASM conformance did not run with WebAssembly.");
  const sqlite3 = await sqlite3InitModule();
  window.__sqlbraidSqlite3 = sqlite3;
  const environmentDatabase = database(sqlite3);
  const environment = await environmentDatabase.db.environment();
  environmentDatabase.native.close();
  const report = {
    runtime: "browser-wasm",
    sqliteVersion: sqlite3.version.libVersion,
    environment,
    contractAssertions: await transactionContracts(sqlite3),
    cases: {
      "wasm.sql.native-transparency": await nativeTransparency(sqlite3),
      "wasm.sql.generated-structure": await generatedStructure(sqlite3),
      "wasm.numeric.exact-integer": await exactInteger(sqlite3),
      "wasm.data.json-text": await jsonTextCase(sqlite3),
      "wasm.execution.stream": await streamCase(sqlite3),
      "wasm.execution.bulk": await bulkCase(sqlite3),
      "wasm.execution.mapped-transaction": await mappedTransaction(sqlite3),
      "wasm.runtime.conservative-scope-admission": await conservativeScopeAdmission(),
    },
  };
  window.__sqlbraidWasmConformance = report;
}

const write = (tx, id) => tx.execute(sql.command`INSERT INTO braid_contract_tx (id) VALUES (${id})`);

async function transactionContracts(sqlite3) {
  // A named VFS file is shared by independent native handles; :memory: would not be an observer.
  // This proves transaction durability between connections, not persistence across browser reloads.
  const native = new sqlite3.oo1.DB("/braid-contract.db", "c");
  const observer = new sqlite3.oo1.DB("/braid-contract.db", "c");
  const db = createSqliteWasmDatabase(native, { sqlite3 });
  const other = createSqliteWasmDatabase(observer, { sqlite3 });
  const rows = async () =>
    (await other.all(sql.rows`SELECT id FROM braid_contract_tx ORDER BY id`)).map((row) => row.id);
  const equalRows = async (expected) =>
    expect(
      JSON.stringify(await rows()) === JSON.stringify(expected),
      "WASM independent observer saw incorrect durable state.",
    );
  const rejects = async (operation) => {
    let failure;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(failure !== undefined, "WASM contract operation unexpectedly succeeded.");
    return failure;
  };
  const assertions = [];
  const runScenario = async (scenario, check) => {
    native.exec("DELETE FROM braid_contract_tx");
    await equalRows([]);
    await check();
    assertions.push({
      fullName: `[contract:sqlite-wasm:${scenario}:integration] [ownership:direct]`,
      status: "passed",
    });
  };
  try {
    expect(
      native !== observer && native.pointer !== observer.pointer,
      "WASM observer must use a separate native connection.",
    );
    native.exec("DROP TABLE IF EXISTS braid_contract_tx; CREATE TABLE braid_contract_tx (id TEXT PRIMARY KEY)");
    await runScenario("transaction.commit-confirmed", async () => {
      const result = await db.tx(async (tx) => {
        await write(tx, "A");
        return "committed";
      });
      expect(result === "committed", "WASM lost the committed callback value.");
      await equalRows(["A"]);
    });
    await runScenario("transaction.callback-rollback", async () => {
      const failure = new Error("WASM callback rollback");
      expect(
        (await rejects(
          db.tx(async (tx) => {
            await write(tx, "A");
            throw failure;
          }),
        )) === failure,
        "WASM callback failure changed.",
      );
      await equalRows([]);
    });
    await runScenario("transaction.statement-rollback", async () => {
      let firstWriteCompleted = false;
      await rejects(
        db.tx(async (tx) => {
          await write(tx, "A");
          firstWriteCompleted = true;
          await write(tx, "A");
        }),
      );
      expect(firstWriteCompleted, "WASM statement failure must follow a successful mutation.");
      await equalRows([]);
    });
    await runScenario("transaction.caught-error-terminal-outcome", async () => {
      const result = await db.tx(async (tx) => {
        await write(tx, "A");
        await rejects(write(tx, "A"));
        return "committed";
      });
      expect(result === "committed", "WASM should commit after a caught constraint violation.");
      await equalRows(["A"]);
    });
    await runScenario("transaction.savepoint-recovery", async () => {
      const failure = new Error("WASM nested rollback");
      await db.tx(async (tx) => {
        await write(tx, "A");
        expect(
          (await rejects(
            tx.tx(async (nested) => {
              await write(nested, "B");
              throw failure;
            }),
          )) === failure,
          "WASM nested failure changed.",
        );
        await rejects(
          tx.tx(async (nested) => {
            await write(nested, "D");
            await write(nested, "A");
          }),
        );
        await write(tx, "C");
      });
      await equalRows(["A", "C"]);
    });
    return assertions;
  } finally {
    observer.close();
    native.close();
  }
}

run().catch((error) => {
  window.__sqlbraidWasmConformanceError = error instanceof Error ? error.message : String(error);
});
