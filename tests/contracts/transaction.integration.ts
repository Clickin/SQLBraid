import assert from "node:assert/strict";
import type { Database, RowQuery } from "@sqlbraid/core";

export interface TransactionIntegrationHarness {
  readonly db: Database;
  /** Reads through a separately opened physical connection, never the transaction's connection. */
  committedRows(): Promise<readonly string[]>;
  write(db: Database, id: string): Promise<unknown>;
  readonly caughtStatementOutcome: "commit" | "rollback";
  physicalId?(db: Database): Promise<string>;
  readonly streamQuery?: RowQuery<{ readonly id: string }>;
  /** The fixture starts empty. Duplicate primary keys must fail without application-side validation. */
  close(): Promise<void>;
  readonly accessMode?: {
    readonly inheritedReadOnly: boolean;
    setDefault?(): Promise<void>;
    restoreDefault?(): Promise<void>;
  };
}

const scenarios: Record<string, (h: TransactionIntegrationHarness) => Promise<void>> = {
  "resource.stream-return": async ({ db, write, committedRows, streamQuery }) => {
    assert.ok(streamQuery, "stream-return contract requires a native streaming query");
    await db.tx(async (tx) => {
      await write(tx, "A");
      await write(tx, "B");
      await write(tx, "C");
    });
    let first: string | undefined;
    for await (const row of db.stream(streamQuery)) {
      first = row.id;
      break;
    }
    assert.equal(first, "A");
    // A max-one pool must have returned its lease; direct adapters must release their iterator.
    await db.tx(async (tx) => { await write(tx, "D"); });
    assert.deepEqual(await committedRows(), ["A", "B", "C", "D"]);
  },
  "resource.session-lease": async (h) => {
    assert.ok(h.physicalId, "pooled session contract requires a native session identifier");
    const physicalId = h.physicalId;
    for (const fails of [false, true]) {
      const failure = new Error("session callback failed");
      const scoped = h.db.session(async (session) => {
        const before = await physicalId(session);
        await session.session(async (nested) => assert.equal(await physicalId(nested), before));
        assert.equal(await physicalId(session), before);
        if (fails) throw failure;
      });
      if (fails) await assert.rejects(scoped, (error) => error === failure);
      else await scoped;
      // The fixtures use a max-one pool: a root query cannot finish if the scope leaked its lease.
      await physicalId(h.db);
    }
  },
  "resource.transaction-lease": async (h) => {
    assert.ok(h.physicalId, "pooled transaction contract requires a native session identifier");
    const physicalId = h.physicalId;
    for (const fails of [false, true]) {
      const failure = new Error("transaction callback failed");
      const scoped = h.db.tx(async (tx) => {
        const before = await physicalId(tx);
        await h.write(tx, fails ? "B" : "A");
        await tx.tx(async (nested) => assert.equal(await physicalId(nested), before));
        assert.equal(await physicalId(tx), before);
        if (fails) throw failure;
      });
      if (fails) await assert.rejects(scoped, (error) => error === failure);
      else await scoped;
      await physicalId(h.db);
      assert.deepEqual(await h.committedRows(), ["A"]);
    }
  },
  "transaction.commit-confirmed": async ({ db, write, committedRows }) => {
    const result = await db.tx(async (tx) => {
      await write(tx, "A");
      return "committed";
    });
    assert.equal(result, "committed");
    assert.deepEqual(await committedRows(), ["A"]);
  },
  "transaction.callback-rollback": async ({ db, write, committedRows }) => {
    const failure = new Error("contract callback rollback");
    await assert.rejects(
      db.tx(async (tx) => {
        await write(tx, "A");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await committedRows(), []);
  },
  "transaction.statement-rollback": async ({ db, write, committedRows }) => {
    let firstWriteCompleted = false;
    await assert.rejects(
      db.tx(async (tx) => {
        await write(tx, "A");
        firstWriteCompleted = true;
        await write(tx, "A");
      }),
    );
    assert.equal(firstWriteCompleted, true);
    assert.deepEqual(await committedRows(), []);
  },
  "transaction.caught-error-terminal-outcome": async ({ db, write, committedRows, caughtStatementOutcome }) => {
    let callbackReturned = false;
    const result = db.tx(async (tx) => {
      await write(tx, "A");
      await assert.rejects(write(tx, "A"));
      callbackReturned = true;
      return "callback succeeded";
    });
    if (caughtStatementOutcome === "rollback") {
      await assert.rejects(result);
      assert.deepEqual(await committedRows(), []);
    } else {
      assert.equal(await result, "callback succeeded");
      assert.deepEqual(await committedRows(), ["A"]);
    }
    assert.equal(callbackReturned, true, "the terminal outcome must follow a successful callback, not an uncaught error");
  },
  "transaction.savepoint-recovery": async ({ db, write, committedRows }) => {
    const failure = new Error("contract nested rollback");
    await db.tx(async (tx) => {
      await write(tx, "A");
      await assert.rejects(
        tx.tx(async (nested) => {
          await write(nested, "B");
          throw failure;
        }),
        (error) => error === failure,
      );
      // A real SQL error must also be recoverable through a savepoint (not just callback errors).
      await assert.rejects(
        tx.tx(async (nested) => {
          await write(nested, "D");
          await write(nested, "A");
        }),
      );
      await write(tx, "C");
    });
    assert.deepEqual(await committedRows(), ["A", "C"]);
  },
  "transaction.access-mode": async ({ db, write, committedRows, accessMode }) => {
    assert.ok(accessMode, "access-mode contract requires a native access-mode fixture");
    await accessMode.setDefault?.();
    try {
      const inherited = db.tx(async (tx) => write(tx, "inherited"));
      if (accessMode.inheritedReadOnly) await assert.rejects(inherited);
      else await inherited;
      await assert.rejects(db.tx({ readOnly: true }, async (tx) => write(tx, "read-only")));
      await db.tx({ readOnly: false }, async (tx) => write(tx, "read-write"));
      assert.deepEqual(
        await committedRows(),
        accessMode.inheritedReadOnly ? ["read-write"] : ["inherited", "read-write"],
      );
    } finally {
      await accessMode.restoreDefault?.();
    }
  },
};

/** Ordinary Vitest tests and the native Bun runner execute exactly the same semantic assertions. */
export function transactionIntegrationTests(
  transport: string,
  mode: string,
  open: () => Promise<TransactionIntegrationHarness>,
  options: { readonly accessMode?: boolean; readonly pooledLease?: boolean; readonly stream?: boolean } = {},
): readonly { readonly title: string; readonly run: () => Promise<void> }[] {
  return Object.entries(scenarios)
    .filter(([scenario]) => scenario !== "transaction.access-mode" || options.accessMode)
    .filter(([scenario]) => scenario !== "resource.stream-return" || options.stream)
    .filter(([scenario]) => !["resource.session-lease", "resource.transaction-lease"].includes(scenario) || options.pooledLease)
    .map(([scenario, run]) => ({
      title: `[contract:${transport}:${scenario}:integration] [ownership:${mode}]`,
      async run() {
        const harness = await open();
        try {
          assert.deepEqual(await harness.committedRows(), [], "contract fixture must start empty");
          await run(harness);
        } finally {
          await harness.close();
        }
      },
    }));
}
