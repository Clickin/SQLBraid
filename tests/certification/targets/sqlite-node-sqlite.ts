import { DatabaseSync } from "node:sqlite";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import {
  createSqliteFixture,
  sqliteCapabilities,
  sqliteTransactionOptions,
  type SqliteStats,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

function createFixture(): Promise<CertificationFixture> {
  const native = new DatabaseSync(":memory:");
  native.exec("CREATE TABLE cert_items (value TEXT NOT NULL)");
  native.exec("CREATE TABLE cert_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)");
  native.exec("INSERT INTO cert_sentinel (id, marker) VALUES (1, 'untouched')");
  native.exec("CREATE TEMP TABLE cert_identity (id TEXT NOT NULL)");
  native.exec("INSERT INTO temp.cert_identity (id) VALUES ('node-sqlite-native-memory')");
  const stats: SqliteStats = { ready: 0, result: 0, streamStarts: 0, streamEnds: 0 };
  const db = createNodeSqliteDatabase(native, {
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
    const probeNative = new DatabaseSync(":memory:");
    probeNative.exec("CREATE TABLE cert_probe (value TEXT NOT NULL)");
    const probeDb = createNodeSqliteDatabase(probeNative);
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
        throw new Error("node:sqlite transaction cleanup did not aggregate the native rollback failure.", { cause: caught });
      }
    } finally {
      try { probeNative.close(); } catch { /* already closed by the fault */ }
    }
  };
  const options: SqliteFixtureOptions = {
    db,
    close: async () => { native.close(); },
    physicalSessionId: "node-sqlite-native-memory",
    capabilities: sqliteCapabilities(),
    expectedTransactionOptions: sqliteTransactionOptions(),
    streamSupported: true,
    sessionSupported: true,
    localReadOnly: false,
    failureCode: "ERR_SQLITE_ERROR",
    streamFailureCode: "ERR_SQLITE_ERROR",
    stats,
    transactionCleanup,
  };
  return Promise.resolve(createSqliteFixture(options));
}

export const nodeSqliteCertificationTarget = {
  id: "sqlite-node-sqlite-node-22-18-0",
  expectedCapabilities: sqliteCapabilities(),
  expectedTransactionOptions: sqliteTransactionOptions(),
  createFixture,
} satisfies Omit<CertificationTarget, "sourceSha">;
