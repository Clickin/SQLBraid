import { DatabaseSync } from "node:sqlite";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createNodeSqliteDatabase } from "@sqlbraid/sqlite/node-sqlite";
import {
  createSqliteFixture,
  RC3_SOURCE_SHA,
  sqliteCapabilities,
  sqliteTransactionOptions,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

function createFixture(): Promise<CertificationFixture> {
  const native = new DatabaseSync(":memory:");
  native.exec("CREATE TABLE cert_items (value TEXT NOT NULL)");
  const stats = { ready: 0, result: 0 };
  const db = createNodeSqliteDatabase(native, {
    observers: [{
      onEvent(event) {
        if (event.type === "bulk:ready") stats.ready += 1;
        if (event.type === "bulk:result") stats.result += 1;
      },
    }],
  });
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
  };
  return Promise.resolve(createSqliteFixture(options));
}

export const nodeSqliteCertificationTarget: CertificationTarget = {
  id: "sqlite-node-sqlite-node-22-18-0",
  sourceSha: RC3_SOURCE_SHA,
  expectedCapabilities: sqliteCapabilities(),
  expectedTransactionOptions: sqliteTransactionOptions(),
  createFixture,
};

export function createNodeSqliteCertificationTarget(sourceSha = RC3_SOURCE_SHA): CertificationTarget {
  return { ...nodeSqliteCertificationTarget, sourceSha };
}
