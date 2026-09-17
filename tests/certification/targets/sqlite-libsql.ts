import { createClient } from "@libsql/client/node";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createLibsqlDatabase } from "@sqlbraid/sqlite/libsql";
import { sql } from "@sqlbraid/sqlite";
import {
  createSqliteFixture,
  libsqlCapabilities,
  libsqlTransactionOptions,
  makeLibsqlDirectory,
  RC3_SOURCE_SHA,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

async function createFixture(): Promise<CertificationFixture> {
  const { directory, cleanup } = await makeLibsqlDirectory();
  const client = createClient({ url: `file:${directory}/database.db`, intMode: "string" });
  try {
    const stats = { ready: 0, result: 0 };
    const db = createLibsqlDatabase(client, {
      intMode: "string",
      observers: [{
        onEvent(event) {
          if (event.type === "bulk:ready") stats.ready += 1;
          if (event.type === "bulk:result") stats.result += 1;
        },
      }],
    });
    await db.execute(sql.command`CREATE TABLE cert_items (value TEXT NOT NULL)`);
    const options: SqliteFixtureOptions = {
      db,
      close: async () => {
        client.close();
        await cleanup();
      },
      physicalSessionId: "libsql-local-file",
      capabilities: libsqlCapabilities(),
      expectedTransactionOptions: libsqlTransactionOptions(),
      streamSupported: false,
      sessionSupported: false,
      localReadOnly: true,
      failureCode: "SQLITE_CONSTRAINT",
      streamFailureCode: "SQLITE_ERROR",
      stats,
    };
    return createSqliteFixture(options);
  } catch (error) {
    client.close();
    await cleanup();
    throw error;
  }
}

export const libsqlCertificationTarget: CertificationTarget = {
  id: "libsql-local-node-22-18-0",
  sourceSha: RC3_SOURCE_SHA,
  expectedCapabilities: libsqlCapabilities(),
  expectedTransactionOptions: libsqlTransactionOptions(),
  createFixture,
};

export function createLibsqlCertificationTarget(sourceSha = RC3_SOURCE_SHA): CertificationTarget {
  return { ...libsqlCertificationTarget, sourceSha };
}
