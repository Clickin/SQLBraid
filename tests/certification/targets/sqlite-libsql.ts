import { createClient } from "@libsql/client/node";
import type { CertificationFixture, CertificationTarget } from "../types.js";
import { createLibsqlDatabase } from "@sqlbraid/sqlite/libsql";
import { sql } from "@sqlbraid/sqlite";
import {
  createSqliteFixture,
  libsqlCapabilities,
  libsqlTransactionOptions,
  makeLibsqlDirectory,
  type SqliteFixtureOptions,
} from "./sqlite-fixture.js";

async function createFixture(): Promise<CertificationFixture> {
  const { directory, cleanup } = await makeLibsqlDirectory();
  const client = createClient({ url: `file:${directory}/database.db`, intMode: "string" });
  try {
    const stats = {
      ready: 0,
      result: 0,
      streamStarts: 0,
      streamEnds: 0,
      iteratorReturns: 0,
      streamReleases: 0,
      activeStreams: 0,
      nativeOperations: 0,
    };
    const observedClient = {
      ...client,
      execute: (...args: Parameters<typeof client.execute>) => {
        stats.nativeOperations += 1;
        return client.execute(...args);
      },
      batch: (...args: Parameters<typeof client.batch>) => {
        stats.nativeOperations += 1;
        return client.batch(...args);
      },
      transaction: (...args: Parameters<typeof client.transaction>) => {
        stats.nativeOperations += 1;
        return client.transaction(...args);
      },
      protocol: client.protocol,
    };
    const db = createLibsqlDatabase(observedClient, {
      intMode: "string",
      observers: [
        {
          onEvent(event) {
            if (event.type === "bulk:ready") stats.ready += 1;
            if (event.type === "bulk:result") stats.result += 1;
            if (event.type === "stream:start") stats.streamStarts += 1;
            if (event.type === "stream:end") stats.streamEnds += 1;
          },
        },
      ],
    });
    await db.execute(sql.command`CREATE TABLE cert_items (value TEXT NOT NULL)`);
    await db.execute(sql.command`CREATE TABLE cert_sentinel (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`);
    await db.execute(sql.command`INSERT INTO cert_sentinel (id, marker) VALUES (1, 'untouched')`);
    await db.execute(sql.command`CREATE TEMP TABLE cert_identity (id TEXT NOT NULL)`);
    await db.execute(sql.command`INSERT INTO temp.cert_identity (id) VALUES ('libsql-local-file')`);
    const versionRow = await db.one(sql.rows<{ readonly version: string }>`SELECT sqlite_version() AS version`);
    if (!/^\d+(?:\.\d+)+$/u.test(versionRow.version))
      throw new Error(`Unable to parse libSQL SQLite version: ${versionRow.version}`);
    const measuredDatabase = { product: "sqlite", version: versionRow.version, edition: "libSQL local SQLite" } as const;
    const transactionCleanup = async (): Promise<void> => {
      const probe = await makeLibsqlDirectory();
      const probeClient = createClient({ url: `file:${probe.directory}/database.db`, intMode: "string" });
      let nativeTransaction: Awaited<ReturnType<typeof probeClient.transaction>> | undefined;
      const observedClient = {
        protocol: probeClient.protocol,
        execute: (statement: Parameters<typeof probeClient.execute>[0]) => probeClient.execute(statement),
        batch: (statements: Parameters<typeof probeClient.batch>[0], mode?: "write" | "read" | "deferred") =>
          probeClient.batch(statements, mode),
        transaction: async (mode?: "write" | "read" | "deferred") => {
          nativeTransaction = await probeClient.transaction(mode);
          return nativeTransaction;
        },
      };
      const probeDb = createLibsqlDatabase(observedClient, { intMode: "string" });
      const primary = new Error("cert-transaction-cleanup");
      try {
        await probeDb.execute(sql.command`CREATE TABLE cert_probe (value TEXT NOT NULL)`);
        let caught: unknown;
        try {
          await probeDb.tx(async (tx) => {
            await tx.execute(sql.command`INSERT INTO cert_probe (value) VALUES (${"native"})`);
            await nativeTransaction?.execute("COMMIT");
            throw primary;
          });
        } catch (error) {
          caught = error;
        }
        const nativeRollbackErrors =
          caught instanceof AggregateError
            ? caught.errors.filter(
                (error) =>
                  error !== primary && error instanceof Error && typeof (error as { code?: unknown }).code === "string",
              )
            : [];
        if (
          !(caught instanceof AggregateError) ||
          !caught.errors.includes(primary) ||
          nativeRollbackErrors.length === 0
        ) {
          throw new Error("libSQL transaction cleanup did not aggregate the native rollback failure.", {
            cause: caught,
          });
        }
      } finally {
        probeClient.close();
        await probe.cleanup();
      }
    };
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
      transactionCleanup,
    };
    return { ...createSqliteFixture(options), measuredDatabase };
  } catch (error) {
    client.close();
    await cleanup();
    throw error;
  }
}

export const libsqlCertificationTarget = {
  id: "libsql-local-node-22-18-0",
  expectedCapabilities: libsqlCapabilities(),
  expectedTransactionOptions: libsqlTransactionOptions(),
  createFixture,
} satisfies Omit<CertificationTarget, "sourceSha">;
