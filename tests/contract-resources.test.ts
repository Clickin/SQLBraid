import assert from "node:assert/strict";
import { test } from "vitest";
import { containsError, exactIdTransports, poolTransports, resourceFixture, resourceOwnerships, streamTransports, transports } from "./contracts/resources.faults.js";

for (const id of poolTransports) {
  test(`[contract:${id}:resource.root-lease:boundary] [ownership:pooled] root success and native failure finalize one lease each`, async () => {
    const { db, state, command } = resourceFixture(id);
    await db.execute(command());
    assert.deepEqual([state.acquired, state.released, state.discarded], [1, 1, 0]);
    const failure = new Error("native execute failed");
    state.executeFailure = failure;
    await assert.rejects(db.execute(command()), error => containsError(error, failure));
    assert.equal(state.acquired, 2);
    assert.equal(state.released + state.discarded, 2);
  });

  test(`[contract:${id}:resource.session-lease:boundary] [ownership:pooled] nested sessions pin and finalize once on callback success and failure`, async () => {
    for (const fail of [false, true]) {
      const { db, state, command } = resourceFixture(id);
      const failure = new Error("session callback failed");
      const pending = db.session(async session => {
        await session.execute(command());
        await session.session(async nested => { await nested.execute(command()); });
        assert.deepEqual([state.acquired, state.released, state.discarded], [1, 0, 0]);
        if (fail) throw failure;
      });
      if (fail) await assert.rejects(pending, error => error === failure);
      else await pending;
      assert.deepEqual([state.acquired, state.released, state.discarded], [1, 1, 0]);
    }
  });

  test(`[contract:${id}:resource.transaction-lease:boundary] [ownership:pooled] transaction success and callback failure release once, control failure discards once`, async () => {
    for (const mode of ["success", "callback", "control"] as const) {
      const { db, state, command } = resourceFixture(id);
      const failure = new Error("transaction failed");
      const pending = db.tx(async tx => {
        await tx.execute(command());
        await tx.execute(command());
        assert.deepEqual([state.acquired, state.released, state.discarded], [1, 0, 0]);
        if (mode === "control") state.terminalFailure = failure;
        if (mode === "callback") throw failure;
      });
      if (mode === "success") await pending;
      else await assert.rejects(pending, error => containsError(error, failure));
      assert.deepEqual([state.acquired, state.released, state.discarded], mode === "control" ? [1, 0, 1] : [1, 1, 0]);
    }
  });
}

for (const id of transports) {
  for (const ownership of resourceOwnerships(id)) test(`[contract:${id}:cancellation.pre-io:boundary] [ownership:${ownership}] pre-aborted signal preserves reason without checkout or native execution`, async () => {
    const { db, state, command } = resourceFixture(id, ownership);
    const reason = new Error("cancel before I/O");
    await assert.rejects(db.execute(command(), { signal: AbortSignal.abort(reason) }), error => error === reason);
    assert.deepEqual([state.acquired, state.io, state.created], [0, 0, 0]);
  });

  test(`[contract:${id}:metadata.affected-rows:boundary] accepts safe counts and rejects unsafe and malformed native counts`, async () => {
    const { db, state, command } = resourceFixture(id);
    const affectedRows = async () => id === "cloudflare-d1"
      ? (await db.bulk([1], command)).affectedRows
      : (await db.execute(command())).command.affectedRows;
    state.count = 7;
    assert.equal(await affectedRows(), 7);
    for (const count of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, "not-a-count"]) {
      state.count = count;
      await assert.rejects(affectedRows(), error => error instanceof Error && ("code" in error && error.code === "BRAID_RESULT_EXACTNESS"));
    }
  });
}

for (const id of exactIdTransports) {
  test(`[contract:${id}:metadata.exact-id:boundary] exact IDs survive later commands and unsafe Numbers fail closed`, async () => {
    const { db, state, insert, command, remove } = resourceFixture(id);
    for (const value of [1n, 9007199254740993n, 9223372036854775807n]) {
      state.insertId = value;
      const result = await db.execute(insert());
      assert.equal(result.command.insertId, String(value));
      assert.equal((await db.execute(command())).command.affectedRows, 1);
      assert.equal((await db.execute(remove())).command.affectedRows, 1);
    }
    state.insertId = Number.MAX_SAFE_INTEGER + 1;
    await assert.rejects(db.execute(insert()), { code: "BRAID_RESULT_EXACTNESS" });
  });
}

for (const id of streamTransports) for (const ownership of resourceOwnerships(id)) {
  test(`[contract:${id}:resource.stream-return:boundary] [ownership:${ownership}] early return closes the native resource before the pool lease`, async () => {
    const { db, state, rows } = resourceFixture(id, ownership);
    for await (const row of db.stream(rows())) { assert.equal(row.value, "one"); break; }
    assert.equal(state.created, 1);
    assert.equal(state.closed, 1);
    assert.equal(state.released + state.discarded, state.acquired);
  });

  test(`[contract:${id}:resource.stream-read-failure:boundary] [ownership:${ownership}] native read failure closes resources and retains the primary error`, async () => {
    const { db, state, rows } = resourceFixture(id, ownership);
    const primary = new Error("native read failed");
    state.readFailure = primary;
    await assert.rejects(async () => { for await (const row of db.stream(rows())) void row; }, error => containsError(error, primary));
    assert.equal(state.created, 1);
    assert.equal(state.closed, 1);
    assert.equal(state.released + state.discarded, state.acquired);
  });

  test(`[contract:${id}:resource.cleanup-failure:boundary] [ownership:${ownership}] simultaneous read and close failures preserve both and prevent healthy reuse`, async () => {
    const { db, state, rows, command } = resourceFixture(id, ownership);
    const primary = new Error("native read failed");
    const cleanup = new Error("native close failed");
    state.readFailure = primary;
    state.cleanupFailure = cleanup;
    await assert.rejects(async () => { for await (const row of db.stream(rows())) void row; }, error => containsError(error, primary) && containsError(error, cleanup));
    assert.equal(state.closed, 1);
    assert.equal(state.released, 0);
    if (state.acquired > 0) assert.equal(state.discarded, 1);
    else {
      const prior = state.io;
      await assert.rejects(db.execute(command()), { code: "BRAID_CONNECTION_POISONED" });
      assert.equal(state.io, prior);
    }
  });
}

for (const id of ["pg", "mysql2", "mariadb", "node-oracledb", "sqlite-wasm"] as const) for (const ownership of resourceOwnerships(id)) {
  test(`[contract:${id}:resource.init-failure:boundary] [ownership:${ownership}] resource created before initialization failure is closed exactly once`, async () => {
    const { db, state, rows } = resourceFixture(id, ownership);
    const failure = new Error("native wrapper initialization failed");
    state.initFailure = failure;
    await assert.rejects(async () => { for await (const row of db.stream(rows())) void row; }, error => containsError(error, failure));
    assert.equal(state.created, 1);
    assert.equal(state.closed, 1);
    assert.equal(state.released + state.discarded, state.acquired);
  });
}

for (const id of ["pg", "mysql2", "mariadb", "node-oracledb"] as const) for (const ownership of resourceOwnerships(id)) {
  test(`[contract:${id}:cancellation.before-handoff:boundary] [ownership:${ownership}] abort immediately after native creation closes before any row escapes`, async () => {
    const { db, state, rows } = resourceFixture(id, ownership);
    const controller = new AbortController();
    const reason = new Error("cancel at native handoff");
    state.onCreate = () => controller.abort(reason);
    let yielded = 0;
    await assert.rejects(async () => { for await (const row of db.stream(rows(), { signal: controller.signal })) { void row; yielded++; } }, error => containsError(error, reason));
    assert.equal(yielded, 0);
    assert.equal(state.created, 1);
    assert.equal(state.closed, 1);
    assert.equal(state.released + state.discarded, state.acquired);
  });

  test(`[contract:${id}:cancellation.iteration:boundary] [ownership:${ownership}] abort between rows closes iteration and finalizes the lease once`, async () => {
    const { db, state, rows } = resourceFixture(id, ownership);
    const controller = new AbortController();
    const reason = new Error("cancel iteration");
    let yielded = 0;
    await assert.rejects(async () => { for await (const row of db.stream(rows(), { signal: controller.signal })) { assert.equal(row.value, "one"); yielded++; controller.abort(reason); } }, error => containsError(error, reason));
    assert.equal(yielded, 1);
    assert.equal(state.closed, 1);
    assert.equal(state.released + state.discarded, state.acquired);
  });

  test(`[contract:${id}:cancellation.in-flight:boundary] [ownership:${ownership}] abort a pending native operation invokes cancellation before finalization`, async () => {
    const { db, state, command } = resourceFixture(id, ownership);
    const controller = new AbortController();
    const reason = new Error("cancel pending I/O");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    state.onExecute = () => { started.resolve(); return finish.promise; };
    const pending = db.execute(command(), { signal: controller.signal });
    const rejected = assert.rejects(pending, error => containsError(error, reason));
    await started.promise;
    controller.abort(reason);
    finish.resolve();
    await rejected;
    assert.equal(state.cancelled, 1);
    assert.equal(state.released, 0);
    assert.equal(state.discarded, state.acquired);
  });
}
