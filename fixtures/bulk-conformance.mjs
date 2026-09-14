function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  return undefined;
}

function fail(message) {
  throw new Error(`Bulk conformance: ${message}`);
}

function check(condition, message) {
  if (!condition) fail(message);
}

async function expectCode(operation, code, label) {
  try {
    await operation();
  } catch (error) {
    check(errorCode(error) === code, `${label} returned ${errorCode(error) ?? "no code"}, expected ${code}.`);
    return;
  }
  fail(`${label} did not fail.`);
}

function bulkEventsSince(events, start) {
  return events.slice(start).filter((event) => event?.type === "bulk:ready" || event?.type === "bulk:result");
}

function assertLifecycle(events, start, itemCount, expectedMode, label) {
  const bulkEvents = bulkEventsSince(events, start);
  check(bulkEvents.length === 2, `${label} emitted ${bulkEvents.length} bulk lifecycle events instead of one ready/result pair.`);
  const ready = bulkEvents[0];
  const result = bulkEvents[1];
  check(ready?.type === "bulk:ready" && result?.type === "bulk:result", `${label} did not emit bulk:ready followed by bulk:result.`);
  check(ready.operationId === result.operationId, `${label} ready/result operation ids differ.`);
  check(ready.itemCount === itemCount && result.itemCount === itemCount, `${label} reported the wrong item count.`);
  check(result.executionMode === expectedMode, `${label} reported execution mode ${String(result.executionMode)} instead of ${expectedMode}.`);
  return result.executionMode;
}

function normalizedRows(rows) {
  return rows.map((row) => ({ id: String(row.id), value: String(row.value) }));
}

function sameRows(actual, expected, label) {
  check(actual.length === expected.length, `${label} returned ${actual.length} rows instead of ${expected.length}.`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    check(left?.id === right?.id && left?.value === right?.value, `${label} row ${index} differed.`);
  }
}

function hasRow(rows, id, value) {
  return rows.some((row) => row.id === String(id) && row.value === value);
}

export async function verifyBulkConformance({
  db,
  sql,
  dialectId,
  expectedMode,
  events,
  transactions = true,
  tableName = "braid_pv16_bulk_conformance",
}) {
  check(db && typeof db.bulk === "function", "db.bulk is required.");
  check(sql && typeof sql.ident === "function" && typeof sql.list === "function", "a dialect SQL tag is required.");
  check(Array.isArray(events), "events must be a mutable event array.");

  const table = sql.ident(tableName);
  const id = sql.ident("id");
  const value = sql.ident("value");
  const fromDual = dialectId === "oracle" ? sql.raw(" FROM dual") : sql.empty;
  const checks = [];
  const readRows = async () => normalizedRows(await db.all(sql.rows`SELECT ${id}, ${value} FROM ${table} ORDER BY ${id}`));
  const insert = (input) => sql.command`
    INSERT INTO ${table} (${id}, ${value})
    VALUES (${input.id}, ${input.value})
  `;
  const insertSelect = (input, values, valueExpression = input.value) => sql.command`
    INSERT INTO ${table} (${id}, ${value})
    SELECT ${input.id}, ${valueExpression}${fromDual}
    WHERE ${input.id} IN (${sql.list(values)})
  `;

  try {
    await db.execute(sql.command`
      CREATE TABLE ${table} (
        ${id} INTEGER PRIMARY KEY,
        ${value} VARCHAR(64)
      )
    `);

    const baseline = events.length;
    let factoryCalls = 0;
    const empty = await db.bulk([], () => {
      factoryCalls += 1;
      return insert({ id: 0, value: "empty" });
    });
    check(empty.inputCount === 0 && empty.affectedRows === 0, "empty bulk returned the wrong result.");
    check(factoryCalls === 0, "empty bulk called its factory.");
    check(bulkEventsSince(events, baseline).length === 0, "empty bulk emitted lifecycle events.");
    checks.push("empty-noop");

    const inputs = [
      { id: 1, value: "one" },
      { id: 2, value: "two" },
      { id: 3, value: "three" },
    ];
    const successStart = events.length;
    const result = await db.bulk(inputs, (input) => insert(input));
    check(result.inputCount === inputs.length, "homogeneous bulk returned the wrong input count.");
    if (result.affectedRows !== undefined) check(result.affectedRows === inputs.length, "homogeneous bulk returned the wrong affected row count.");
    const successMode = assertLifecycle(events, successStart, inputs.length, expectedMode, "homogeneous bulk");
    sameRows(await readRows(), inputs.map((input) => ({ id: String(input.id), value: input.value })), "homogeneous bulk");
    checks.push("homogeneous");

    const unchanged = await readRows();
    const guardedStart = events.length;
    await expectCode(
      () => db.bulk(
        [{ id: 101, value: "guard-off", guard: false }, { id: 102, value: "guard-on", guard: true }],
        (input) => sql.command`
          INSERT INTO ${table} (${id}, ${value})
          SELECT ${input.id}, ${input.value}${fromDual}
          WHERE 1 = 1
          /*@braid if ${input.guard}*/
            AND ${input.id} = ${input.id}
          /*@braid end*/
        `,
      ),
      "BRAID_BULK_SHAPE",
      "guarded shape mismatch",
    );
    check(bulkEventsSince(events, guardedStart).length === 0, "guarded shape mismatch emitted a bulk lifecycle.");
    sameRows(await readRows(), unchanged, "guarded shape mismatch");
    checks.push("guarded-shape-before-io");

    const listStart = events.length;
    await expectCode(
      () => db.bulk(
        [{ id: 201, value: "list-one", ids: [201] }, { id: 202, value: "list-two", ids: [202, 999] }],
        (input) => insertSelect(input, input.ids),
      ),
      "BRAID_BULK_SHAPE",
      "list cardinality mismatch",
    );
    check(bulkEventsSince(events, listStart).length === 0, "list cardinality mismatch emitted a bulk lifecycle.");
    sameRows(await readRows(), unchanged, "list cardinality mismatch");
    checks.push("list-cardinality-before-io");

    const hintStart = events.length;
    const hint = dialectId === "oracle"
      ? { databaseType: "VARCHAR2", length: 64 }
      : dialectId === "mssql"
        ? { databaseType: "varchar", length: 64 }
        : { databaseType: "VARCHAR", length: 64 };
    await expectCode(
      () => db.bulk(
        [{ id: 301, value: "hint-free" }, { id: 302, value: "hinted" }],
        (input, index) => insertSelect(input, [input.id], index === 0 ? input.value : sql.bind(input.value, hint)),
      ),
      "BRAID_BULK_SHAPE",
      "hint mismatch",
    );
    check(bulkEventsSince(events, hintStart).length === 0, "hint mismatch emitted a bulk lifecycle.");
    sameRows(await readRows(), unchanged, "hint mismatch");
    checks.push("hint-mismatch-before-io");

    const outStart = events.length;
    await expectCode(
      () => db.bulk([{ id: 401, value: "out" }], (input) => sql.command`
        UPDATE ${table} SET ${value} = ${sql.out("result")} WHERE ${id} = ${input.id}
      `),
      "BRAID_CALL_ONLY",
      "OUT command rejection",
    );
    check(bulkEventsSince(events, outStart).length === 0, "OUT command rejection emitted a bulk lifecycle.");
    const inOutStart = events.length;
    await expectCode(
      () => db.bulk([{ id: 402, value: "inout" }], (input) => sql.command`
        UPDATE ${table} SET ${value} = ${sql.inOut("result", input.value)} WHERE ${id} = ${input.id}
      `),
      "BRAID_CALL_ONLY",
      "INOUT command rejection",
    );
    check(bulkEventsSince(events, inOutStart).length === 0, "INOUT command rejection emitted a bulk lifecycle.");
    sameRows(await readRows(), unchanged, "OUT/INOUT command rejection");
    checks.push("out-inout-rejected");

    const failureStart = events.length;
    let failure;
    try {
      await db.bulk([{ id: 900, value: "failure-first" }, { id: 900, value: "failure-duplicate" }], (input) => insert(input));
    } catch (error) {
      failure = error;
    }
    check(failure !== undefined, "duplicate-key bulk did not fail.");
    const failureEvents = events.slice(failureStart);
    const failureReady = failureEvents.find((event) => event?.type === "bulk:ready");
    const failureError = failureEvents.find((event) => event?.type === "query:error");
    check(failureReady !== undefined && failureError !== undefined, "failed bulk did not report ready and query:error events.");
    check(!failureEvents.some((event) => event?.type === "bulk:result"), "failed bulk reported a successful result.");
    check(failureReady.operationId === failureError.operationId, "failed bulk error was associated with another operation.");
    checks.push("failure-cleanup");

    await db.execute(sql.command`INSERT INTO ${table} (${id}, ${value}) VALUES (${901}, ${"after-failure"})`);
    check(hasRow(await readRows(), 901, "after-failure"), "database was not usable after a failed bulk.");
    checks.push("postfailure-usable");

    if (transactions) {
      let rollback;
      const rollbackCause = new Error("bulk conformance rollback");
      try {
        await db.tx(async (tx) => {
          await tx.bulk([{ id: 910, value: "rolled-back" }], (input) => insert(input));
          throw rollbackCause;
        });
      } catch (error) {
        rollback = error;
      }
      if (rollback !== rollbackCause) throw new Error("Bulk conformance: transaction bulk did not propagate callback failure.", { cause: rollback });
      check(!hasRow(await readRows(), 910, "rolled-back"), "transaction bulk did not roll back its write.");
      await db.bulk([{ id: 911, value: "after-rollback" }], (input) => insert(input));
      check(hasRow(await readRows(), 911, "after-rollback"), "database was not usable after transaction rollback.");
      checks.push("tx-bulk-rollback");
    } else {
      let callbackCalled = false;
      await expectCode(
        () => db.tx(async () => {
          callbackCalled = true;
        }),
        "BRAID_TX_UNSUPPORTED",
        "unsupported transaction",
      );
      check(callbackCalled === false, "unsupported transaction invoked its callback.");
      await db.bulk([{ id: 912, value: "after-unsupported-tx" }], (input) => insert(input));
      check(hasRow(await readRows(), 912, "after-unsupported-tx"), "database was not usable after unsupported transaction.");
      checks.push("tx-unsupported-usable");
    }

    return { checks, executionMode: successMode };
  } finally {
    await db.execute(sql.command`DROP TABLE ${table}`).catch(() => undefined);
  }
}
