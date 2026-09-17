import { createRequire } from "node:module";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createBetterSqlite3Database, type BetterSqlite3DatabaseLike } from "@sqlbraid/sqlite/better-sqlite3";
import {
  createSqliteFixture,
  RC3_SOURCE_SHA,
  sqliteCapabilities,
  sqliteTransactionOptions,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

const BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3") as new (filename: string) => BetterSqlite3DatabaseLike & { close(): void; exec(sql: string): unknown };

function createFixture(): Promise<CertificationFixture> {
  const native = new BetterSqlite3(":memory:");
  native.exec("CREATE TABLE cert_items (value TEXT NOT NULL)");
  const stats = { ready: 0, result: 0 };
  const db = createBetterSqlite3Database(native, {
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
    physicalSessionId: "better-sqlite3-native-memory",
    capabilities: sqliteCapabilities(),
    expectedTransactionOptions: sqliteTransactionOptions(),
    streamSupported: true,
    sessionSupported: true,
    localReadOnly: false,
    failureCode: "SQLITE_CONSTRAINT_NOTNULL",
    streamFailureCode: "SQLITE_ERROR",
    stats,
  };
  return Promise.resolve(createSqliteFixture(options));
}

export const betterSqlite3CertificationTarget: CertificationTarget = {
  id: "better-sqlite3-node-22-18-0",
  sourceSha: RC3_SOURCE_SHA,
  expectedCapabilities: sqliteCapabilities(),
  expectedTransactionOptions: sqliteTransactionOptions(),
  createFixture,
};

export function createBetterSqlite3CertificationTarget(sourceSha = RC3_SOURCE_SHA): CertificationTarget {
  return { ...betterSqlite3CertificationTarget, sourceSha };
}
