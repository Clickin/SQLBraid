import assert from "node:assert/strict";
import { createDatabase, createPooledDatabase, DatabaseCardinalityError } from "@sqlbraid/runtime";
import { capture, createSqlTag, guarded, sql } from "@sqlbraid/template";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as sqlite } from "@sqlbraid/sqlite";
import { sql as oracle } from "@sqlbraid/oracle";
import { sql as mssql } from "@sqlbraid/mssql";

function barrier() {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function standardSchema(validate, vendor = "runtime-smoke") {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate,
    },
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => (
    error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code
  ));
}

async function expectSame(action, expected) {
  await assert.rejects(action, (error) => error === expected);
}

function resultFor(rendered, rows) {
  if (rendered.resultKind === "command") {
    return { kind: "command", rows: [], rowCount: 2, command: { affectedRows: 2 } };
  }
  if (rendered.text.includes("empty")) return { kind: "rows", rows: [], rowCount: 0 };
  if (rendered.text.includes("many")) {
    return { kind: "rows", rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
  }
  return { kind: "rows", rows: rows ?? [{ id: 1 }], rowCount: rows?.length ?? 1 };
}

function physical(log, options = {}) {
  return {
    async query(rendered) {
      if (rendered.text.includes("driver-failure") && options.driverFailure !== undefined) {
        throw options.driverFailure;
      }
      log.push(`query:${rendered.text}`);
      return resultFor(rendered, options.rows);
    },
    async *stream(rendered) {
      log.push(`stream:${rendered.text}`);
      for (const row of options.streamRows ?? [{ id: 1 }]) yield row;
      if (rendered.text.includes("stream-failure") && options.streamFailure !== undefined) {
        throw options.streamFailure;
      }
    },
    async begin() { log.push("begin"); },
    async commit() { log.push("commit"); },
    async rollback() { log.push("rollback"); },
    async savepoint(name) { log.push(`savepoint:${name}`); },
    async rollbackTo(name) { log.push(`rollback-to:${name}`); },
    async releaseSavepoint(name) { log.push(`release:${name}`); },
  };
}

function pooledFake(options = {}) {
  const records = [];
  const provider = {
    async acquire() {
      const record = {
        id: `lease-${records.length + 1}`,
        log: [],
        releaseCount: 0,
        discard: false,
      };
      const executor = physical(record.log, options);
      const lease = {
        ...executor,
        release(releaseOptions = {}) {
          record.releaseCount += 1;
          record.discard = releaseOptions.discard === true;
        },
      };
      records.push(record);
      return lease;
    },
  };
  return { provider, records };
}

function assertEventDurations(events) {
  for (const event of events) {
    assert.equal(Object.hasOwn(event, "duration"), false);
    if (
      event.type === "query:result"
      || event.type === "query:mapped"
      || event.type === "stream:end"
      || (event.type === "transaction" && event.status !== "requested")
    ) {
      assert.equal(typeof event.durationMs, "number");
    }
    if (event.type === "query:error" && event.durationMs !== undefined) {
      assert.equal(typeof event.durationMs, "number");
    }
  }
}

async function templateCoreSmoke() {
  const pg = sql;
  const pgRendered = pg`SELECT ${pg.ident(["public", "users"])} WHERE id IN (${pg.list([3, 5])}) AND state = ${"ready"}`.render();
  assert.equal(
    pgRendered.text,
    'SELECT "public"."users" WHERE id IN ($1, $2) AND state = $3',
  );
  assert.deepEqual(pgRendered.values, [3, 5, "ready"]);
  assert.deepEqual(pgRendered.bindingMap, [
    { placeholder: 1 },
    { placeholder: 2 },
    { placeholder: 3, interpolation: 2 },
  ]);

  const joined = pg.join(
    [pg.fragment`(${10})`, pg.fragment`(${20})`],
    pg.fragment`, `,
  );
  assert.equal(pg`VALUES ${joined}`.render().text, "VALUES ($1), ($2)");
  assert.deepEqual(pg`VALUES ${joined}`.render().values, [10, 20]);

  const selected = pg`
    SELECT *
    FROM users
    /*@braid where*/
      /*@braid choose*/
        /*@braid when ${false}*/ AND id = ${99}
        /*@braid when ${true}*/ AND email = ${"ada@example.com"}
        /*@braid otherwise*/ AND active = ${true}
      /*@braid end*/
    /*@braid end*/
  `.render();
  assert.match(selected.text, /WHERE\s+email = \$1/);
  assert.doesNotMatch(selected.text, /@braid|id =|active =/);
  assert.deepEqual(selected.values, ["ada@example.com"]);

  const update = pg`
    UPDATE users
    /*@braid set*/
      /*@braid if ${true}*/ name = ${"Ada"}, /*@braid end*/
      /*@braid if ${false}*/ email = ${"not-rendered"}, /*@braid end*/
    /*@braid end*/
    WHERE id = ${7}
  `.render();
  assert.match(update.text, /SET\s+name = \$1\s+WHERE id = \$2/);
  assert.deepEqual(update.values, ["Ada", 7]);

  const trimmed = pg`SELECT 1 /*@braid trim prefix="WHERE " prefixOverrides="AND|OR"*/ AND id = ${8} /*@braid end*/`.render();
  assert.match(trimmed.text, /WHERE\s+id = \$1/);
  assert.doesNotMatch(trimmed.text, /@braid|\bAND\b/);
  assert.deepEqual(trimmed.values, [8]);
  assert.equal(
    mysql`SELECT ${mysql.ident("users.name")} WHERE id = ${4}`.render().text,
    "SELECT `users`.`name` WHERE id = ?",
  );
  assert.deepEqual(mysql`SELECT ${mysql.ident("users.name")} WHERE id = ${4}`.render().values, [4]);
  assert.equal(
    sqlite`SELECT ${sqlite.ident("users.name")} WHERE id = ${4}`.render().text,
    'SELECT "users"."name" WHERE id = ?',
  );
  assert.deepEqual(sqlite`SELECT ${sqlite.ident("users.name")} WHERE id = ${4}`.render().values, [4]);
  const hinted = sql`SELECT ${sql.bind("Ada", { databaseType: "VARCHAR2", length: 40 })}`.render();
  assert.equal(hinted.text, "SELECT $1");
  assert.deepEqual(hinted.values, ["Ada"]);
  assert.deepEqual(hinted.parameterHints, [{ databaseType: "VARCHAR2", length: 40 }]);
  assert.equal(oracle`SELECT ${1}`.render().text, "SELECT :1");
  assert.equal(mssql`SELECT ${1}`.render().text, "SELECT @p1");

  const encoder = new TextEncoder();
  assert.equal(encoder.encode("ASCII").length, 5);
  assert.equal(encoder.encode("한").length, 3);
  assert.equal(encoder.encode("😀").length, 4);
  assert.equal(encoder.encode("e\u0301").length, 3);
  const unicodeSql = "SELECT 'ASCII 한 😀 e\u0301'";
  const unicodeBytes = encoder.encode(unicodeSql).length;
  const exact = createSqlTag({ limits: { maxSqlBytes: unicodeBytes } });
  assert.equal(exact`SELECT 'ASCII 한 😀 é'`.render().text, unicodeSql);
  const tooSmall = createSqlTag({ limits: { maxSqlBytes: unicodeBytes - 1 } });
  assert.throws(
    () => tooSmall`SELECT 'ASCII 한 😀 é'`.render(),
    (error) => error?.code === "BRAID_SQL_LIMIT",
  );

  const mappedSchema = standardSchema((value) => ({
    value: { id: value.id, accepted: true },
  }), "runtime-smoke-template");
  const captured = capture(sql.rows(mappedSchema), ["SELECT ", ""], (values) => {
    values[0] = 1;
  });
  assert.equal(captured.resultKind, "rows");
  assert.equal(captured.resultSchema, mappedSchema);
  assert.deepEqual(captured.render().values, [1]);
  const guardedQuery = guarded(sql.rows(mappedSchema), ["SELECT ", ""], [() => 1]);
  assert.equal(guardedQuery.resultSchema, mappedSchema);
  assert.deepEqual(guardedQuery.render().values, [1]);
}

async function runtimeSmoke() {
  const directLog = [];
  const direct = createDatabase(physical(directLog));
  assert.deepEqual(await direct.execute(sql`SELECT row`), {
    kind: "rows",
    rows: [{ id: 1 }],
    rowCount: 1,
  });
  assert.deepEqual(await direct.execute(sql.command`UPDATE users SET active = ${true}`), {
    kind: "command",
    rows: [],
    rowCount: 2,
    command: { affectedRows: 2 },
  });

  const querySchema = standardSchema(async (value) => {
    await Promise.resolve();
    return { value: { id: value.id, source: "query" } };
  });
  const executionSchema = standardSchema(async (value) => {
    await Promise.resolve();
    return { value: { ...value, source: "execution" } };
  });
  const mapped = await direct.all(sql.rows(querySchema)`SELECT mapped`, { schema: executionSchema });
  assert.deepEqual(mapped, [{ id: 1, source: "execution" }]);

  const cardinalityEvents = [];
  const cardinality = createDatabase(physical([]), {
    observers: [{ async onEvent(event) {
      await Promise.resolve();
      cardinalityEvents.push(event);
    } }],
  });
  await assert.rejects(
    () => cardinality.one(sql.rows`SELECT many`),
    (error) => error instanceof DatabaseCardinalityError && error.expected === "one" && error.actual === 2,
  );
  await assert.rejects(
    () => cardinality.maybeOne(sql.rows`SELECT many`),
    (error) => error instanceof DatabaseCardinalityError && error.expected === "maybeOne" && error.actual === 2,
  );
  const cardinalityErrors = cardinalityEvents.filter((event) => event.type === "query:error");
  assert.deepEqual(cardinalityErrors.map((event) => event.stage), ["cardinality", "cardinality"]);
  assertEventDurations(cardinalityEvents);

  const orderTrace = [];
  const ordered = createDatabase(physical(orderTrace), {
    observers: [
      { async onEvent(event) { await Promise.resolve(); orderTrace.push(`A:${event.type}`); } },
      { async onEvent(event) { await Promise.resolve(); orderTrace.push(`B:${event.type}`); } },
    ],
  });
  await ordered.execute(sql`SELECT observer-order`);
  assert.deepEqual(orderTrace, [
    "A:query:ready",
    "B:query:ready",
    "query:SELECT observer-order",
    "A:query:result",
    "B:query:result",
    "A:query:mapped",
    "B:query:mapped",
  ]);

  const pooledMapping = pooledFake();
  let pooledMappingDb;
  const releaseBeforeMapper = standardSchema(async (value) => {
    await Promise.resolve();
    assert.equal(
      pooledMapping.records.reduce((sum, record) => sum + record.releaseCount, 0),
      1,
    );
    await pooledMappingDb.execute(sql`SELECT mapper-reentry`);
    return { value: { id: value.id, nested: true } };
  });
  pooledMappingDb = createPooledDatabase(pooledMapping.provider);
  assert.deepEqual(
    await pooledMappingDb.all(sql.rows(releaseBeforeMapper)`SELECT mapper-outer`),
    [{ id: 1, nested: true }],
  );
  assert.equal(pooledMapping.records.length, 2);
  assert.deepEqual(pooledMapping.records.map((record) => record.releaseCount), [1, 1]);

  const observerTrace = [];
  const observerEvents = [];
  let observerDb;
  const observer = {
    async onEvent(event) {
      observerEvents.push(event);
      await Promise.resolve();
      if (event.type === "query:mapped" && event.transactionScoped) {
        await expectCode(() => observerDb.execute(sql`SELECT observer-escape`), "BRAID_TX_SCOPE");
        observerTrace.push("observer-escape-blocked");
      }
    },
  };
  const observerPool = pooledFake();
  observerDb = createPooledDatabase(observerPool.provider, { observers: [observer] });
  const queryEscapeSchema = standardSchema(async (value) => {
    await Promise.resolve();
    await expectCode(() => observerDb.execute(sql`SELECT query-mapper-escape`), "BRAID_TX_SCOPE");
    return { value };
  });
  const executionEscapeSchema = standardSchema(async (value) => {
    await Promise.resolve();
    await expectCode(() => observerDb.execute(sql`SELECT execution-mapper-escape`), "BRAID_TX_SCOPE");
    return { value: { ...value, checked: true } };
  });
  await observerDb.tx(async (tx) => {
    await tx.execute(sql.rows(queryEscapeSchema)`SELECT query-mapper`);
    assert.deepEqual(
      await tx.all(sql.rows`SELECT execution-mapper`, { schema: executionEscapeSchema }),
      [{ id: 1, checked: true }],
    );
  });
  assert.equal(observerTrace.length, 2);

  const failClosedError = new Error("observer refused acquisition");
  let acquisitionCount = 0;
  const failClosedDb = createPooledDatabase({
    async acquire() {
      acquisitionCount += 1;
      return { ...physical([]), release() {} };
    },
  }, {
    observers: [{
      onEvent(event) {
        if (event.type === "query:ready") throw failClosedError;
      },
    }],
  });
  await expectSame(() => failClosedDb.execute(sql`SELECT blocked`), failClosedError);
  assert.equal(acquisitionCount, 0);

  const directTxLog = [];
  const directTx = createDatabase(physical(directTxLog));
  await directTx.tx(async (parent) => {
    await parent.execute(sql`SELECT parent-before`);
    await parent.tx(async (nested) => {
      await expectCode(() => parent.execute(sql`SELECT parent-blocked`), "BRAID_TX_SCOPE");
      await expectCode(() => parent.tx(async () => undefined), "BRAID_TX_SCOPE");
      await nested.execute(sql`SELECT nested`);
    });
    await parent.execute(sql`SELECT parent-after`);
    await expectCode(() => directTx.execute(sql`SELECT root-blocked`), "BRAID_TX_SCOPE");
  });
  assert.equal(directTxLog[0], "begin");
  assert.ok(directTxLog.some((entry) => entry.startsWith("savepoint:")));
  assert.ok(directTxLog.includes("release:" + directTxLog.find((entry) => entry.startsWith("savepoint:")).slice("savepoint:".length)));
  assert.equal(directTxLog.at(-1), "commit");

  const concurrent = pooledFake();
  const firstEntered = barrier();
  const secondEntered = barrier();
  const concurrentDb = createPooledDatabase(concurrent.provider);
  const first = concurrentDb.tx(async (tx) => {
    firstEntered.resolve();
    await secondEntered.promise;
    await expectCode(() => concurrentDb.execute(sql`SELECT first-root-escape`), "BRAID_TX_SCOPE");
    await tx.execute(sql`SELECT first-scoped`);
  });
  const second = concurrentDb.tx(async (tx) => {
    await firstEntered.promise;
    secondEntered.resolve();
    await expectCode(() => concurrentDb.execute(sql`SELECT second-root-escape`), "BRAID_TX_SCOPE");
    await tx.execute(sql`SELECT second-scoped`);
  });
  await Promise.all([first, second]);
  assert.equal(concurrent.records.length, 2);
  assert.deepEqual(concurrent.records.map((record) => record.releaseCount), [1, 1]);
  assert.ok(concurrent.records.every((record) => record.log.includes("begin") && record.log.includes("commit")));
  assert.deepEqual(concurrent.records.map((record) => record.log.filter((entry) => entry.startsWith("query:"))), [
    ["query:SELECT first-scoped"],
    ["query:SELECT second-scoped"],
  ]);

  const unrelated = pooledFake();
  const unrelatedDb = createPooledDatabase(unrelated.provider);
  const transactionEntered = barrier();
  const releaseTransaction = barrier();
  const transaction = unrelatedDb.tx(async () => {
    transactionEntered.resolve();
    await releaseTransaction.promise;
  });
  await transactionEntered.promise;
  await unrelatedDb.execute(sql`SELECT unrelated-root-work`);
  releaseTransaction.resolve();
  await transaction;
  assert.equal(unrelated.records.length, 2);
  assert.deepEqual(unrelated.records.map((record) => record.releaseCount), [1, 1]);

  const pinned = pooledFake();
  const pinnedDb = createPooledDatabase(pinned.provider);
  await pinnedDb.tx(async (parent) => {
    await parent.execute(sql`SELECT pinned-one`);
    await parent.tx(async (nested) => {
      await expectCode(() => parent.execute(sql`SELECT blocked-parent`), "BRAID_TX_SCOPE");
      await nested.execute(sql`SELECT pinned-two`);
    });
    await parent.execute(sql`SELECT pinned-three`);
  });
  assert.equal(pinned.records.length, 1);
  assert.equal(pinned.records[0].releaseCount, 1);
  assert.equal(pinned.records[0].log.filter((entry) => entry.startsWith("query:")).length, 3);
  assert.ok(pinned.records[0].log.some((entry) => entry.startsWith("savepoint:")));
  assert.ok(pinned.records[0].log.some((entry) => entry.startsWith("release:")));

  const directStreamLog = [];
  let directStreamDb;
  const streamEscapeSchema = standardSchema(async (value) => {
    await Promise.resolve();
    await expectCode(() => directStreamDb.execute(sql`SELECT stream-reentry`), "BRAID_STREAM_SCOPE");
    return { value };
  });
  directStreamDb = createDatabase(physical(directStreamLog));
  const directRows = [];
  for await (const row of directStreamDb.stream(sql.rows(streamEscapeSchema)`SELECT direct-stream`)) {
    directRows.push(row);
  }
  assert.deepEqual(directRows, [{ id: 1 }]);

  const pooledStream = pooledFake();
  let pooledStreamDb;
  const pooledStreamSchema = standardSchema(async (value) => {
    await Promise.resolve();
    assert.equal(pooledStream.records[0].releaseCount, 0);
    await pooledStreamDb.execute(sql`SELECT pooled-stream-reentry`);
    assert.deepEqual(pooledStream.records.map((record) => record.releaseCount), [0, 1]);
    return { value };
  });
  pooledStreamDb = createPooledDatabase(pooledStream.provider);
  const pooledRows = [];
  for await (const row of pooledStreamDb.stream(sql.rows(pooledStreamSchema)`SELECT pooled-stream`)) {
    pooledRows.push(row);
  }
  assert.deepEqual(pooledRows, [{ id: 1 }]);
  assert.equal(pooledStream.records.length, 2);
  assert.deepEqual(pooledStream.records.map((record) => record.releaseCount), [1, 1]);

  const transactionToken = { kind: "transaction-rejection" };
  await expectSame(
    () => directTx.tx(async () => {
      await Promise.resolve();
      throw transactionToken;
    }),
    transactionToken,
  );
  await directTx.execute(sql`SELECT reusable-after-rejection`);

  const driverToken = { kind: "driver-rejection" };
  const driverFailureDb = createDatabase(physical([], { driverFailure: driverToken }));
  await expectSame(() => driverFailureDb.execute(sql`SELECT driver-failure`), driverToken);

  const streamToken = { kind: "stream-rejection" };
  const streamFailureDb = createDatabase(physical([], { streamFailure: streamToken }));
  await expectSame(async () => {
    for await (const row of streamFailureDb.stream(sql.rows`SELECT stream-failure`)) void row;
  }, streamToken);

  assertEventDurations(cardinalityEvents);
  assertEventDurations(observerEvents);
}

export async function runRuntimeSmoke() {
  await templateCoreSmoke();
  await runtimeSmoke();
}
