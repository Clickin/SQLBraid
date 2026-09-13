import assert from "node:assert/strict";
import { test } from "vitest";
import { mssqlParameter, sql, typePolicy } from "@sqlbraid/mssql";
import {
  createTediousExecutor,
  createTediousPoolProvider,
  tediousStatementBinding,
  type TediousConnectionLike,
  type TediousRequestLike,
} from "@sqlbraid/mssql/tedious";

function mockConnection(run: (request: TediousRequestLike) => void): TediousConnectionLike {
  return {
    execSql: run,
    beginTransaction(callback: (error?: unknown) => void) { callback(); },
    commitTransaction(callback: (error?: unknown) => void) { callback(); },
    rollbackTransaction(callback: (error?: unknown) => void) { callback(); },
    saveTransaction(callback: (error?: unknown) => void) { callback(); },
  };
}

function emit(request: TediousRequestLike, event: string, ...args: unknown[]): void {
  (request as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(event, ...args);
}

test("MSSQL dialect renders deterministic parameters and bracket identifiers", () => {
  const query = sql`SELECT ${1}, ${"Ada"}`;
  const rendered = query.render();
  assert.deepEqual(rendered.segments, ["SELECT ", ", ", ""]);
  assert.deepEqual(rendered.parameters, [{ value: 1, interpolation: 0 }, { value: "Ada", interpolation: 1 }]);
  assert.equal(
    tediousStatementBinding.describe(rendered, { dialectId: "mssql", requestedReuse: "auto" }).parameterizedSql,
    "SELECT @p1, @p2",
  );
  assert.equal(sql`SELECT ${sql.ident("a]b")}`.render().segments[0], "SELECT [a]]b]");
  assert.equal(typePolicy.id, "mssql-default");
});

test("MSSQL parameter factories preserve explicit metadata", () => {
  assert.deepEqual(mssqlParameter.nvarchar(200), { databaseType: "nvarchar", length: 200 });
  assert.deepEqual(mssqlParameter.nvarchar("max"), { databaseType: "nvarchar", length: "max" });
  assert.deepEqual(mssqlParameter.decimal(19, 4), { databaseType: "decimal", precision: 19, scale: 4 });
  assert.throws(() => mssqlParameter.nvarchar(4001), /lengths/u);
  assert.throws(() => mssqlParameter.decimal(10, 11), /scale/u);
});

test("MSSQL bind hints align with rendered values", () => {
  const query = sql`SELECT ${sql.bind(null, mssqlParameter.nvarchar(20))}`;
  const rendered = query.render();
  assert.equal(
    tediousStatementBinding.describe(rendered, { dialectId: "mssql", requestedReuse: "auto" }).parameterizedSql,
    "SELECT @p1",
  );
  assert.deepEqual(rendered.parameters.map((parameter) => parameter.value), [null]);
  assert.deepEqual(rendered.parameters.map((parameter) => parameter.hint), [mssqlParameter.nvarchar(20)]);
});

test("MSSQL adapter honors int hints and rejects ignored type facets", async () => {
  const executor = createTediousExecutor(mockConnection((request) => emit(request, "requestCompleted")));
  await assert.doesNotReject(() => executor.query(sql`SELECT ${sql.bind(1, mssqlParameter.int())}`.render()));
  await assert.rejects(
    () => executor.query(sql`SELECT ${sql.bind(1, { databaseType: "int", length: 1 })}`.render()),
    /does not support length/u,
  );
  await assert.rejects(
    () => executor.query(sql`SELECT ${sql.bind("Ada", { databaseType: "varchar", length: 3, precision: 1 })}`.render()),
    /does not support precision/u,
  );
  await assert.rejects(
    () => executor.query(sql`SELECT ${sql.bind(1, { databaseType: "decimal", precision: 10, scale: 2, length: 4 })}`.render()),
    /does not support length/u,
  );
});

test("MSSQL typed materialization rejects out-of-range values before execution", async () => {
  let executions = 0;
  const executor = createTediousExecutor(mockConnection(() => { executions += 1; }));
  await assert.rejects(
    () => executor.query(sql`SELECT ${sql.bind(2_147_483_648, mssqlParameter.int())}`.render()),
    /invalid SQL Server int parameter/u,
  );
  assert.equal(executions, 0);
});

test("MSSQL direct adapters reject pool connections while pool leases release once", async () => {
  let releases = 0;
  const connection = {
    execSql() {},
    beginTransaction(callback: (error?: unknown) => void) { callback(); },
    commitTransaction(callback: (error?: unknown) => void) { callback(); },
    rollbackTransaction(callback: (error?: unknown) => void) { callback(); },
    saveTransaction(callback: (error?: unknown) => void) { callback(); },
    release() { releases += 1; },
  };
  assert.throws(() => createTediousExecutor(connection), /not a pool/u);
  const lease = await createTediousPoolProvider({ acquire: async () => connection }).acquire();
  await lease.release();
  await lease.release({ discard: true });
  assert.equal(releases, 1);
});

test("MSSQL calls accept OUTPUT text in literals and comments", async () => {
  const executor = createTediousExecutor(mockConnection((request) => {
    emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
    emit(request, "row", [{ value: 1 }]);
    emit(request, "doneInProc", 1);
    emit(request, "requestCompleted");
  }));
  assert.ok(executor.call);
  const result = await executor.call(sql.call`SELECT 'OUTPUT' AS value /* OUTPUT */`.render());
  assert.deepEqual(result.resultSets, [{ rows: [{ value: 1 }] }]);
});

test("MSSQL query rejects actual output return values instead of discarding them", async () => {
  const executor = createTediousExecutor(mockConnection((request) => {
    emit(request, "returnValue", "answer", 42);
    emit(request, "requestCompleted");
  }));
  await assert.rejects(
    () => executor.query(sql`SELECT 1`.render()),
    /BRAID_CALL_OUT_UNSUPPORTED/u,
  );
});

test("MSSQL row decode failures reject and cancel the request", async () => {
  let cancelled = false;
  let activeRequest: TediousRequestLike | undefined;
  const executor = createTediousExecutor(mockConnection((request) => {
    activeRequest = request;
    (request as unknown as { cancel(): void }).cancel = () => { cancelled = true; };
    emit(request, "columnMetadata", [{ colName: "value", type: "Int" }]);
    emit(request, "row", [{ value: { value: 1 } }]);
  }), {
    typePolicy: { ...typePolicy, decode: () => { throw new Error("decode failed"); } },
  });
  let settled = false;
  const operation = executor.query(sql`SELECT 1`.render());
  const rejected = assert.rejects(operation, /decode failed/u).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(settled, false, "The physical request must drain before the operation releases its connection.");
  assert.ok(activeRequest);
  emit(activeRequest, "requestCompleted");
  await rejected;
});
