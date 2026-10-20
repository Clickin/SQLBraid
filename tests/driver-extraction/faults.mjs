import assert from "node:assert/strict";
import { test } from "node:test";
import { pgConnection, pgPool } from "@execution-lab/driver";

function fake({ query, release, end } = {}) {
  const calls = [];
  const client = {
    escapeIdentifier: pgEscape,
    escapeLiteral: pgEscape,
    async query(config) {
      calls.push(config.text);
      return query ? query(config) : { rows: [], fields: [], rowCount: 0, command: config.text.split(" ")[0] };
    },
    release(discard) {
      calls.push(["release", discard]);
      return release?.(discard);
    },
    async end() {
      calls.push("end");
      return end?.();
    },
  };
  return {
    client,
    calls,
    provider: pgPool({
      async connect() {
        return client;
      },
    }),
  };
}
function pgEscape(value) {
  return value;
} // Never used: the tests send only fixed control SQL.
const statement = { sql: "SELECT 1" };

await test("native results and errors retain identity; nontransaction query errors recover", async () => {
  const error = new Error("query failure");
  const rows = [{ answer: 42 }];
  const fields = [{ name: "answer", dataTypeID: 23 }];
  let fail = true;
  const io = fake({
    query() {
      if (fail) throw error;
      return { rows, fields, rowCount: 1, command: "SELECT" };
    },
  });
  const connection = pgConnection(io.client);
  await assert.rejects(connection.execute(statement), (actual) => actual === error);
  fail = false;
  const result = await connection.execute(statement);
  assert.equal(result.rows, rows);
  assert.equal(result.columns, fields);
  assert.equal(result.affectedRows, undefined, "SELECT rowCount is not affectedRows.");
  await connection.release();
  assert.equal(io.calls.at(-1), "end");
});

await test("overlap and duplicate ownership reject; released leases stay closed", async () => {
  let finish;
  const io = fake({
    query: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const connection = pgConnection(io.client);
  assert.throws(() => pgConnection(io.client), { code: "BUSY" });
  const pending = connection.execute(statement);
  await assert.rejects(connection.execute(statement), { code: "BUSY" });
  await assert.rejects(connection.begin(), { code: "BUSY" });
  await assert.rejects(connection.release(), { code: "BUSY" });
  finish({ rows: [], fields: [], command: "SELECT" });
  await pending;
  const releasing = connection.release();
  assert.equal(connection.release(), releasing);
  await releasing;
  await assert.rejects(connection.execute(statement), { code: "CLOSED" });
  await assert.rejects(connection.begin(), { code: "CLOSED" });
  assert.equal(io.calls.filter((call) => call === "end").length, 1);
});

await test("cancellation and malformed parameters reject before native IO", async () => {
  const io = fake();
  const connection = pgConnection(io.client);
  const reason = new Error("already aborted");
  await assert.rejects(
    connection.execute(statement, { signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  await assert.rejects(connection.execute(statement, { signal: new AbortController().signal }), {
    code: "UNSUPPORTED",
  });
  await assert.rejects(connection.execute({ sql: "SELECT $1", parameters: [undefined] }), TypeError);
  const sparse = [];
  sparse.length = 1;
  await assert.rejects(connection.execute({ sql: "SELECT $1", parameters: sparse }), TypeError);
  assert.deepEqual(io.calls, []);
  assert.equal(connection.capabilities.cancellation, false);
  assert.equal(connection.capabilities.streaming, false);
  assert.equal(connection.stream, undefined);
  await connection.release();
});

await test("transaction state guards and query failure require explicit rollback", async () => {
  const error = new Error("query failed inside transaction");
  const io = fake({
    query({ text }) {
      if (text === "FAIL") throw error;
      return { rows: [], command: text.split(" ")[0] };
    },
  });
  const connection = await io.provider.acquire();
  await assert.rejects(connection.commit(), { code: "TRANSACTION_STATE" });
  await assert.rejects(connection.rollback(), { code: "TRANSACTION_STATE" });
  await connection.begin();
  await assert.rejects(connection.begin(), { code: "TRANSACTION_STATE" });
  await assert.rejects(connection.execute({ sql: "FAIL" }), (actual) => actual === error);
  await assert.rejects(connection.execute(statement), { code: "TRANSACTION_STATE" });
  await assert.rejects(connection.commit(), { code: "TRANSACTION_STATE" });
  await connection.rollback();
  await connection.execute(statement);
  await connection.release();
  assert.deepEqual(io.calls.at(-1), ["release", undefined]);
});

for (const control of ["BEGIN", "COMMIT", "ROLLBACK"]) {
  await test(`failed ${control} poisons and discards the lease`, async () => {
    const error = new Error(`${control} failed`);
    let failed = false;
    const io = fake({
      query({ text }) {
        if (text.startsWith(control) && !failed) {
          failed = true;
          throw error;
        }
        return { rows: [], command: text.split(" ")[0] };
      },
    });
    const connection = await io.provider.acquire();
    if (control === "BEGIN") await assert.rejects(connection.begin(), (actual) => actual === error);
    else {
      await connection.begin();
      await assert.rejects(
        control === "COMMIT" ? connection.commit() : connection.rollback(),
        (actual) => actual === error,
      );
    }
    await assert.rejects(connection.execute(statement), { code: "POISONED" });
    await connection.release();
    assert.equal(io.calls.at(-2), "ROLLBACK");
    assert.deepEqual(io.calls.at(-1), ["release", true]);
    assert.throws(() => pgConnection(io.client), { code: "BUSY" });
  });
}

await test("release rolls back an unfinished transaction before returning the client", async () => {
  const io = fake();
  const connection = await io.provider.acquire();
  await connection.begin();
  await connection.release();
  assert.deepEqual(io.calls.slice(-2), ["ROLLBACK", ["release", undefined]]);
  const next = await io.provider.acquire();
  await next.execute(statement);
  await next.release({ discard: true });
  assert.deepEqual(io.calls.at(-1), ["release", true]);
});

await test("release reports rollback plus release failures, never retries physical release", async () => {
  const rollbackError = new Error("rollback cleanup failed");
  const releaseError = new Error("release cleanup failed");
  const io = fake({
    query({ text }) {
      if (text === "ROLLBACK") throw rollbackError;
      return { rows: [], command: "BEGIN" };
    },
    release() {
      throw releaseError;
    },
  });
  const connection = await io.provider.acquire();
  await connection.begin();
  const released = connection.release();
  await assert.rejects(
    released,
    (error) => error instanceof AggregateError && error.errors[0] === rollbackError && error.errors[1] === releaseError,
  );
  assert.equal(connection.release(), released);
  assert.deepEqual(io.calls.at(-1), ["release", true]);
  await assert.rejects(connection.execute(statement), { code: "CLOSED" });
});

await test("failed direct close remains terminal", async () => {
  const error = new Error("end failed");
  const io = fake({
    end() {
      throw error;
    },
  });
  const connection = pgConnection(io.client);
  await assert.rejects(connection.release(), (actual) => actual === error);
  await assert.rejects(connection.execute(statement), { code: "CLOSED" });
  assert.throws(() => pgConnection(io.client), { code: "BUSY" });
});

await test("server rollback reported for COMMIT is not mistaken for a successful commit", async () => {
  const io = fake({ query: ({ text }) => ({ rows: [], command: text === "COMMIT" ? "ROLLBACK" : text }) });
  const connection = await io.provider.acquire();
  await connection.begin();
  await assert.rejects(connection.commit());
  await connection.release();
  assert.deepEqual(io.calls.at(-1), ["release", true]);
});

await test("releasing a failed transaction closes the stale lease", async () => {
  const io = fake({
    query({ text }) {
      if (text === "FAIL") throw new Error("query failed");
      return { rows: [], command: text };
    },
  });
  const connection = await io.provider.acquire();
  await connection.begin();
  await assert.rejects(connection.execute({ sql: "FAIL" }));
  await connection.release();
  await assert.rejects(connection.execute(statement), { code: "CLOSED" });
});

await test("multiple-result payloads reject rather than silently selecting a result", async () => {
  const io = fake({ query: () => [{ rows: [] }, { rows: [] }] });
  const connection = pgConnection(io.client);
  await assert.rejects(connection.execute({ sql: "SELECT 1; SELECT 2" }), { code: "UNSUPPORTED" });
  await connection.release();
});

await test("invalid pooled clients are discarded even when wrapper initialization fails", async () => {
  const io = fake();
  delete io.client.escapeIdentifier;
  await assert.rejects(io.provider.acquire(), TypeError);
  assert.deepEqual(io.calls, [["release", true]]);
  const releaseError = new Error("discard failed");
  const broken = fake({
    release() {
      throw releaseError;
    },
  });
  delete broken.client.escapeIdentifier;
  await assert.rejects(
    broken.provider.acquire(),
    (error) =>
      error instanceof AggregateError && error.errors[0] instanceof TypeError && error.errors[1] === releaseError,
  );
});
