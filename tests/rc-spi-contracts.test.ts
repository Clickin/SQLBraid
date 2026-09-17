import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createBulkBindingDescription,
  createStatementBindingDescription,
  type ConnectionLease,
  type ConnectionProvider,
  type DriverRoutineResult,
  type ExecutionOptions,
  type Query,
  type RenderedBulk,
  type RenderedStatement,
  type StatementBindingAdapter,
  type StatementBindingDescription,
  type StatementBindingContext,
  type TransactionOptions,
} from "@sqlbraid/core";
import { createPooledDatabase } from "@sqlbraid/runtime";
import { sql as mysql } from "@sqlbraid/mysql";
import { sql as postgres } from "@sqlbraid/postgres";

type PortableRow = {
  readonly dialect: string;
  readonly lease: number;
  readonly value?: unknown;
};

type SyntheticLog = {
  readonly dialect: string;
  readonly lease: number;
  readonly kind: string;
};

function createSyntheticBinding(): StatementBindingAdapter {
  return Object.freeze({
    id: "rc-spi-synthetic",
    describe(statement: RenderedStatement, context: StatementBindingContext) {
      return createStatementBindingDescription(statement, context, {
        adapterId: "rc-spi-synthetic",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: {
          effective: context.requestedReuse === "reuse" ? "reuse" : "simple",
          owner: "sqlbraid",
        },
      });
    },
    describeBulk(bulk: RenderedBulk, context: StatementBindingContext) {
      return createBulkBindingDescription(bulk, context, {
        adapterId: "rc-spi-synthetic",
        transport: "text-positional",
        placeholder: (index) => `$${index}`,
        reuse: {
          effective: context.requestedReuse === "reuse" ? "reuse" : "simple",
          owner: "sqlbraid",
        },
      });
    },
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason;
}

function createSyntheticProvider() {
  const statementBinding = createSyntheticBinding();
  const logs: SyntheticLog[] = [];
  const lifecycle: string[] = [];
  const leases: ConnectionLease[] = [];
  let acquireCount = 0;
  let releaseCount = 0;
  let activeCancellationWaits = 0;
  let cancellations = 0;
  let streamsSettled = 0;
  let markCancellationStarted!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => {
    markCancellationStarted = resolve;
  });

  const waitForCancellation = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
      const settle = () => {
        signal.removeEventListener("abort", settle);
        activeCancellationWaits -= 1;
        cancellations += 1;
        reject(abortError(signal));
      };
      activeCancellationWaits += 1;
      markCancellationStarted();
      if (signal.aborted) settle();
      else signal.addEventListener("abort", settle, { once: true });
    });

  const leaseFor = (leaseId: number): ConnectionLease => {
    const ownershipKey = {};
    const lease: ConnectionLease = {
      ownershipKey,
      statementBinding,
      environment: {
        database: { product: "synthetic-sql" },
        driver: { id: "rc-spi-synthetic" },
        capabilities: {
          "statement.cancel": { status: "guaranteed" },
          "statement.prepare": { status: "guaranteed" },
          "statement.stream": { status: "guaranteed" },
          "statement.bulk": { status: "guaranteed" },
          transaction: { status: "guaranteed" },
          "transaction.savepoint": { status: "guaranteed" },
          "transaction.read-only": { status: "guaranteed" },
          "transaction.isolation.serializable": { status: "guaranteed" },
          "routine.out": { status: "guaranteed" },
          "routine.result-sets": { status: "guaranteed" },
          "routine.out-cursor": { status: "guaranteed" },
          "routine.return-value": { status: "guaranteed" },
        },
      },
      async query<Row>(
        rendered: RenderedStatement,
        _binding?: StatementBindingDescription,
        options?: ExecutionOptions,
      ) {
        assert.equal(lease.statementBinding, statementBinding);
        logs.push({ dialect: rendered.dialectId, lease: leaseId, kind: `query:${rendered.resultKind}` });
        if (rendered.segments.join("").includes("WAIT FOR CANCELLATION")) {
          if (!options?.signal) throw new Error("synthetic cancellation query requires a signal");
          await waitForCancellation(options.signal);
        }
        if (rendered.resultKind === "command") {
          return {
            kind: "command",
            rows: [],
            rowCount: 1,
            command: { affectedRows: 1 },
          };
        }
        return {
          kind: "rows",
          rows: [
            {
              dialect: rendered.dialectId,
              lease: leaseId,
              value: rendered.parameters[0]?.value,
            },
          ] as unknown as readonly Row[],
        };
      },
      async *stream<Row>(
        rendered: RenderedStatement,
        _binding?: StatementBindingDescription,
        options?: ExecutionOptions,
      ): AsyncIterable<Row> {
        assert.equal(lease.statementBinding, statementBinding);
        logs.push({ dialect: rendered.dialectId, lease: leaseId, kind: "stream" });
        try {
          yield { dialect: rendered.dialectId, lease: leaseId, value: 1 } as unknown as Row;
          yield { dialect: rendered.dialectId, lease: leaseId, value: 2 } as unknown as Row;
        } finally {
          streamsSettled += 1;
          lifecycle.push(`stream-settled:${leaseId}`);
        }
        void options;
      },
      async call(rendered: RenderedStatement, _binding, _options): Promise<DriverRoutineResult> {
        assert.equal(lease.statementBinding, statementBinding);
        logs.push({ dialect: rendered.dialectId, lease: leaseId, kind: "call" });
        return {
          output: { lease: leaseId, dialect: rendered.dialectId },
          resultSets: [{ rows: [{ lease: leaseId }], source: { kind: "emitted", index: 0 } }],
          returnValue: 7,
        };
      },
      async bulk(bulk) {
        assert.equal(lease.statementBinding, statementBinding);
        logs.push({ dialect: bulk.statement.dialectId, lease: leaseId, kind: "bulk" });
        return {
          inputCount: bulk.parameterSets.length,
          affectedRows: bulk.parameterSets.length,
          executionMode: "prepared-loop",
        };
      },
      async begin(options?: TransactionOptions) {
        lifecycle.push(`begin:${leaseId}:${options?.isolation ?? "default"}:${options?.readOnly === true}`);
      },
      async commit() {
        lifecycle.push(`commit:${leaseId}`);
      },
      async rollback() {
        lifecycle.push(`rollback:${leaseId}`);
      },
      async savepoint(name: string) {
        lifecycle.push(`savepoint:${leaseId}:${name}`);
      },
      async rollbackTo(name: string) {
        lifecycle.push(`rollback-to:${leaseId}:${name}`);
      },
      async releaseSavepoint(name: string) {
        lifecycle.push(`release-savepoint:${leaseId}:${name}`);
      },
      async release() {
        releaseCount += 1;
        lifecycle.push(`release:${leaseId}`);
      },
    };
    leases.push(lease);
    return lease;
  };

  const provider: ConnectionProvider = {
    statementBinding,
    environment: {
      database: { product: "synthetic-sql" },
      driver: { id: "rc-spi-synthetic" },
      capabilities: {
        "statement.cancel": { status: "guaranteed" },
        "statement.prepare": { status: "guaranteed" },
        "statement.stream": { status: "guaranteed" },
        "statement.bulk": { status: "guaranteed" },
        transaction: { status: "guaranteed" },
        "transaction.savepoint": { status: "guaranteed" },
        "transaction.read-only": { status: "guaranteed" },
        "transaction.isolation.serializable": { status: "guaranteed" },
        "routine.out": { status: "guaranteed" },
        "routine.result-sets": { status: "guaranteed" },
        "routine.out-cursor": { status: "guaranteed" },
        "routine.return-value": { status: "guaranteed" },
      },
    },
    async acquire() {
      acquireCount += 1;
      const lease = leaseFor(acquireCount);
      assert.equal(lease.statementBinding, provider.statementBinding);
      return lease;
    },
  };

  return {
    provider,
    logs,
    lifecycle,
    leases,
    cancellationStarted,
    counts: () => ({
      acquireCount,
      releaseCount,
      activeCancellationWaits,
      cancellations,
      streamsSettled,
    }),
  };
}

test("synthetic SPI covers ordinary, prepared, routine, stream, bulk and cancellation", async () => {
  const fixture = createSyntheticProvider();
  const db = createPooledDatabase(fixture.provider);
  const rowQuery = postgres.rows<PortableRow>`SELECT ${11}`;

  const ordinary = await db.one(rowQuery);
  assert.deepEqual(ordinary, { dialect: "postgres", lease: 1, value: 11 });

  const prepared = db.prepare("portable-row", (value: number) => postgres.rows<PortableRow>`SELECT ${value}`);
  assert.deepEqual(await prepared.one(12), { dialect: "postgres", lease: 2, value: 12 });

  const routine = db.prepare("portable-routine", (value: number) => postgres.call`CALL work(${value})`);
  assert.deepEqual(await routine.call(13), {
    output: { dialect: "postgres", lease: 3 },
    resultSets: [{ rows: [{ lease: 3 }] }],
    returnValue: 7,
  });

  const streamed: PortableRow[] = [];
  for await (const row of db.stream(postgres.rows<PortableRow>`SELECT stream`)) streamed.push(row);
  assert.deepEqual(streamed, [
    { dialect: "postgres", lease: 4, value: 1 },
    { dialect: "postgres", lease: 4, value: 2 },
  ]);

  assert.deepEqual(await db.bulk([14, 15], (value) => postgres.command`UPDATE items SET value = ${value}`), {
    inputCount: 2,
    affectedRows: 2,
  });

  const controller = new AbortController();
  const cancelled = db.execute(postgres`WAIT FOR CANCELLATION`, { signal: controller.signal });
  await fixture.cancellationStarted;
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(cancelled, /synthetic cancellation/u);
  assert.deepEqual(fixture.counts(), {
    acquireCount: 6,
    releaseCount: 6,
    activeCancellationWaits: 0,
    cancellations: 1,
    streamsSettled: 1,
  });
});

test("one adapter serves multiple dialects while a session pins one lease", async () => {
  const fixture = createSyntheticProvider();
  const db = createPooledDatabase(fixture.provider);
  const queries: readonly Query<PortableRow, "rows">[] = [
    postgres.rows<PortableRow>`SELECT ${21}`,
    mysql.rows<PortableRow>`SELECT ${22}`,
  ];
  let escaped: typeof db | undefined;

  await db.session(async (session) => {
    escaped = session;
    for (const query of queries) {
      const row = await session.one(query);
      assert.equal(row.lease, 1);
    }
    await session.session(async (nested) => {
      assert.deepEqual(await nested.one(mysql.rows<PortableRow>`SELECT ${23}`), {
        dialect: "mysql",
        lease: 1,
        value: 23,
      });
    });
    await session.tx({ isolation: "serializable", readOnly: true }, async (transaction) => {
      assert.deepEqual(await transaction.one(postgres.rows<PortableRow>`SELECT ${24}`), {
        dialect: "postgres",
        lease: 1,
        value: 24,
      });
      await transaction.tx(async (savepoint) => {
        assert.deepEqual(await savepoint.one(mysql.rows<PortableRow>`SELECT ${25}`), {
          dialect: "mysql",
          lease: 1,
          value: 25,
        });
      });
      await assert.rejects(
        () => transaction.tx({}, async () => undefined),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_TX_OPTIONS_NESTED",
      );
    });
    await assert.rejects(
      () => db.execute(postgres`SELECT root misuse`),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_SCOPE",
    );
  });

  assert.deepEqual(fixture.counts(), {
    acquireCount: 1,
    releaseCount: 1,
    activeCancellationWaits: 0,
    cancellations: 0,
    streamsSettled: 0,
  });
  assert.equal(fixture.lifecycle.includes("begin:1:serializable:true"), true);
  assert.equal(fixture.lifecycle.includes("commit:1"), true);
  assert.equal(
    fixture.lifecycle.some((entry) => entry.startsWith("savepoint:1:")),
    true,
  );
  assert.equal(
    fixture.lifecycle.some((entry) => entry.startsWith("release-savepoint:1:")),
    true,
  );
  assert.equal(fixture.lifecycle.filter((entry) => entry === "release:1").length, 1);
  assert.equal(
    fixture.logs.every(({ lease }) => lease === 1),
    true,
  );

  await assert.rejects(
    () => escaped!.one(postgres.rows<PortableRow>`SELECT closed`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BRAID_SESSION_CLOSED",
  );
  assert.equal(fixture.provider.statementBinding, fixture.leases[0]?.statementBinding);
  assert.deepEqual(
    fixture.logs.map(({ dialect }) => dialect),
    ["postgres", "mysql", "mysql", "postgres", "mysql"],
  );
});

test("transaction cleanup settles savepoints and releases a failed session lease", async () => {
  const fixture = createSyntheticProvider();
  const db = createPooledDatabase(fixture.provider);

  for (const options of [{ isolation: "drop table" }, { readOnly: "yes" }]) {
    await assert.rejects(
      () => db.tx(options as never, async () => undefined),
      (error: unknown) => error instanceof TypeError && "code" in error && error.code === "BRAID_TX_OPTIONS_INVALID",
    );
  }
  assert.equal(fixture.counts().acquireCount, 0);
  assert.equal(
    fixture.lifecycle.some((entry) => entry.startsWith("begin:")),
    false,
  );

  await assert.rejects(
    () =>
      db.session(async (session) =>
        session.tx(async (transaction) => {
          await transaction.tx(async (savepoint) => {
            await savepoint.execute(postgres`SELECT nested`);
            throw new Error("rollback savepoint");
          });
        }),
      ),
    /rollback savepoint/u,
  );
  assert.equal(
    fixture.lifecycle.some((entry) => entry.startsWith("rollback-to:1:")),
    true,
  );
  assert.equal(
    fixture.lifecycle.some((entry) => entry.startsWith("release-savepoint:1:")),
    true,
  );
  assert.equal(fixture.lifecycle.includes("rollback:1"), true);
  assert.equal(fixture.lifecycle.filter((entry) => entry === "release:1").length, 1);
});

test("environment advertises canonical common capabilities without legacy aliases", async () => {
  const fixture = createSyntheticProvider();
  const environment = await createPooledDatabase(fixture.provider).environment();
  assert.equal(environment.capabilities["statement.cancel"]?.status, "guaranteed");
  assert.equal(environment.capabilities["statement.prepare"]?.status, "guaranteed");
  assert.equal(environment.capabilities["statement.stream"]?.status, "guaranteed");
  assert.equal(environment.capabilities["statement.bulk"]?.status, "guaranteed");
  assert.equal(environment.capabilities.transaction?.status, "guaranteed");
  assert.equal(environment.capabilities["transaction.savepoint"]?.status, "guaranteed");
  assert.equal(environment.capabilities["routine.out"]?.status, "guaranteed");
  assert.equal(environment.capabilities["routine.result-sets"]?.status, "guaranteed");
  assert.equal(environment.capabilities["routine.out-cursor"]?.status, "guaranteed");
  assert.equal(environment.capabilities["routine.return-value"]?.status, "guaranteed");
  assert.equal("execution.stream" in environment.capabilities, false);
  assert.equal("execution.bulk" in environment.capabilities, false);
  assert.equal("execution.transaction" in environment.capabilities, false);
});

test("common Query keeps one application row type across dialect-selected tags", () => {
  const postgresQuery: Query<PortableRow, "rows"> = postgres.rows<PortableRow>`SELECT ${31}`;
  const mysqlQuery: Query<PortableRow, "rows"> = mysql.rows<PortableRow>`SELECT ${32}`;
  assert.equal(postgresQuery.resultKind, "rows");
  assert.equal(mysqlQuery.resultKind, "rows");
  assert.notEqual(postgresQuery.render().dialectId, mysqlQuery.render().dialectId);
});
