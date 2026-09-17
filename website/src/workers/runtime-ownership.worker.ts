import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sql } from "@sqlbraid/sqlite";
import { createSqliteWasmDatabase } from "@sqlbraid/sqlite/wasm";
import { verifyBulkConformance } from "../../../fixtures/bulk-conformance.mjs";
import type { ExecutionEvent } from "@sqlbraid/core";

interface OwnershipRequest {
  readonly type: "run";
}

interface OwnershipSuccess {
  readonly type: "success";
  readonly checks: readonly string[];
  readonly bulkConformance: Readonly<Record<string, unknown>>;
}

interface OwnershipFailure {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "BROWSER_RUNTIME_OWNERSHIP";
}

function hasCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

async function createDatabase(events: ExecutionEvent[]) {
  const sqlite3 = await sqlite3InitModule();
  const native = new sqlite3.oo1.DB(":memory:");
  native.exec(
    "CREATE TABLE ownership (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ownership VALUES (1, 'one'), (2, 'two'), (3, 'three');",
  );
  return createSqliteWasmDatabase(native, {
    sqlite3,
    observers: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
}

async function run(): Promise<OwnershipSuccess> {
  const events: ExecutionEvent[] = [];
  const db = await createDatabase(events);
  const bulkConformance = await verifyBulkConformance({
    db,
    sql,
    dialectId: "sqlite",
    expectedMode: "prepared-loop",
    events,
  });
  const checks: string[] = [];

  await db.tx(async (tx) => {
    await tx.tx(async (nested) => {
      await nested.execute(sql.command`UPDATE ownership SET value = ${"nested"} WHERE id = ${1}`);
    });
  });
  checks.push("nested-tx");

  await db.tx(async () => {
    await Promise.all(
      [db.execute(sql.command`UPDATE ownership SET value = ${"escape"} WHERE id = ${1}`), Promise.resolve()].map(
        async (operation) => {
          try {
            await operation;
          } catch (error) {
            if (!hasCode(error, "BRAID_TX_SCOPE")) throw error;
          }
        },
      ),
    );
  });
  checks.push("root-escape");

  await db.tx(async (tx) => {
    const iterator = tx.stream(sql.rows`SELECT id FROM ownership ORDER BY id`)[Symbol.asyncIterator]();
    await iterator.next();
    try {
      await tx.execute(sql.command`UPDATE ownership SET value = ${"stream"} WHERE id = ${2}`);
      throw new Error("transaction stream re-entry was accepted");
    } catch (error) {
      if (!hasCode(error, "BRAID_STREAM_SCOPE")) throw error;
    } finally {
      await iterator.return?.();
    }
  });
  checks.push("stream-ownership");

  const mapperFailure = new Error("mapper re-entry was accepted");
  await (async () => {
    try {
      for await (const _row of db.stream(sql.rows`SELECT id FROM ownership ORDER BY id`, {
        schema: {
          "~standard": {
            version: 1,
            vendor: "SQLBraid browser ownership",
            async validate(value: unknown) {
              try {
                await db.one(sql.rows`SELECT id FROM ownership WHERE id = ${1}`);
              } catch (error) {
                if (hasCode(error, "BRAID_STREAM_SCOPE")) return { value };
                throw error;
              }
              throw mapperFailure;
            },
          },
        },
      }))
        void _row;
      throw mapperFailure;
    } catch (error) {
      if (error !== mapperFailure && !hasCode(error, "BRAID_STREAM_SCOPE")) throw error;
    }
  })();
  checks.push("mapper-reentry");

  for await (const _row of db.stream(sql.rows`SELECT id FROM ownership ORDER BY id`)) break;
  await db.execute(sql.command`UPDATE ownership SET value = ${"after-break"} WHERE id = ${2}`);
  checks.push("break-cleanup");

  const streamFailure = new Error("stream failure");
  await (async () => {
    try {
      for await (const _row of db.stream(sql.rows`SELECT id FROM ownership ORDER BY id`, {
        schema: {
          "~standard": {
            version: 1,
            vendor: "SQLBraid browser ownership",
            validate() {
              throw streamFailure;
            },
          },
        },
      }))
        void _row;
    } catch (error) {
      if (error !== streamFailure) throw error;
    }
  })();
  await db.execute(sql.command`UPDATE ownership SET value = ${"after-error"} WHERE id = ${3}`);
  checks.push("error-cleanup");

  const concurrent = await Promise.allSettled([
    db.execute(sql.command`UPDATE ownership SET value = ${"branch-a"} WHERE id = ${1}`),
    db.execute(sql.command`UPDATE ownership SET value = ${"branch-b"} WHERE id = ${2}`),
  ]);
  const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected.length !== 1 || !hasCode(rejected[0]!.reason, "BRAID_REENTRY")) {
    throw new Error("Concurrent browser root branches were not conservatively rejected.");
  }
  checks.push("concurrent-branches");

  checks.push(`bulk-conformance:${bulkConformance.executionMode}`);
  return { type: "success", checks, bulkConformance };
}

self.addEventListener("message", (event: MessageEvent<OwnershipRequest>) => {
  if (event.data?.type !== "run") return;
  void run()
    .then((response) => self.postMessage(response))
    .catch((error: unknown) => {
      self.postMessage({
        type: "error",
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      } satisfies OwnershipFailure);
    });
});
