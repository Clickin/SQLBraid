import { createRequire } from "node:module";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createBetterSqlite3Database, type BetterSqlite3DatabaseLike } from "@sqlbraid/sqlite/better-sqlite3";
import {
  createSqliteFixture,
  sqliteCapabilities,
  sqliteTransactionOptions,
  type SqliteStats,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

const BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3") as new (filename: string) => BetterSqlite3DatabaseLike & { close(): void; exec(sql: string): unknown };

function createFixture(): Promise<CertificationFixture> {
  const native = new BetterSqlite3(":memory:");
  native.exec("CREATE TABLE cert_items (value TEXT NOT NULL)");
  native.exec("CREATE TABLE cert_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)");
  native.exec("INSERT INTO cert_sentinel (id, marker) VALUES (1, 'untouched')");
  native.exec("CREATE TEMP TABLE cert_identity (id TEXT NOT NULL)");
  native.exec("INSERT INTO temp.cert_identity (id) VALUES ('better-sqlite3-native-memory')");
  const stats: SqliteStats = { ready: 0, result: 0, streamStarts: 0, streamEnds: 0 };
  const db = createBetterSqlite3Database(native, {
    observers: [{
      onEvent(event) {
        if (event.type === "bulk:ready") stats.ready += 1;
        if (event.type === "bulk:result") stats.result += 1;
        if (event.type === "stream:start") stats.streamStarts += 1;
        if (event.type === "stream:end") stats.streamEnds += 1;
      },
    }],
  });
  const transactionCleanup = async (): Promise<void> => {
    const probeNative = new BetterSqlite3(":memory:");
    probeNative.exec("CREATE TABLE cert_probe (value TEXT NOT NULL)");
    const probeDb = createBetterSqlite3Database(probeNative);
    const primary = new Error("cert-transaction-cleanup");
    try {
      let caught: unknown;
      try {
        await probeDb.tx(async () => {
          probeNative.close();
          throw primary;
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof AggregateError) || !caught.errors.includes(primary)) {
        throw new Error("better-sqlite3 transaction cleanup did not aggregate the native rollback failure.", { cause: caught });
      }
    } finally {
      try { probeNative.close(); } catch { /* already closed by the fault */ }
    }
  };
  const options: SqliteFixtureOptions = {
    db,
    close: async () => { native.close(); },
    physicalSessionId: "better-sqlite3-native-memory",
    capabilities: sqliteCapabilities(),
    expectedTransactionOptions: sqliteTransactionOptions(),
    streamSupported: true,
    sessionSupported: true,
    localReadOnly: false,
    failureCode: "SQLITE_CONSTRAINT_NOTNULL",
    streamFailureCode: "SQLITE_ERROR",
    stats,
    transactionCleanup,
  };
  return Promise.resolve(createSqliteFixture(options));
}

export const betterSqlite3CertificationTarget = {
  id: "better-sqlite3-node-22-18-0",
  expectedCapabilities: sqliteCapabilities(),
  expectedTransactionOptions: sqliteTransactionOptions(),
  createFixture,
} satisfies Omit<CertificationTarget, "sourceSha">;
