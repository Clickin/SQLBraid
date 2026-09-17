import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionProvider } from "@sqlbraid/core";
import { createPgPoolProvider } from "@sqlbraid/postgres/pg";
import { createMysql2PoolProvider } from "@sqlbraid/mysql/mysql2";
import { createMariaDbPoolProvider } from "@sqlbraid/mariadb/mariadb";
import { createTediousPoolProvider } from "@sqlbraid/mssql/tedious";
import { createBunSqlProvider, type BunSqlClient, type BunSqlReservedClient } from "@sqlbraid/bun-sql";

const providers: readonly {
  name: string;
  create(checkout: () => void, release: () => Promise<void>, setup: () => void): ConnectionProvider;
}[] = [
  {
    name: "PostgreSQL",
    create(checkout, release, setup) {
      return createPgPoolProvider({
        async connect() {
          checkout();
          return {
            query: async () => ({ rows: [], fields: [] }),
            get escapeIdentifier() {
              setup();
              return (value: string) => value;
            },
            escapeLiteral: (value: string) => value,
            release,
          };
        },
      });
    },
  },
  {
    name: "mysql2",
    create(checkout, release, setup) {
      return createMysql2PoolProvider({
        async getConnection() {
          checkout();
          return {
            execute: async () => [[], []] as const,
            beginTransaction: async () => undefined,
            commit: async () => undefined,
            rollback: async () => undefined,
            get config() {
              setup();
              return {};
            },
            release,
            destroy() {},
          };
        },
      });
    },
  },
  {
    name: "MariaDB",
    create(checkout, release, setup) {
      return createMariaDbPoolProvider({
        async getConnection() {
          checkout();
          return {
            execute: async () => [],
            beginTransaction: async () => undefined,
            commit: async () => undefined,
            rollback: async () => undefined,
            get query() {
              setup();
              return async () => [];
            },
            release,
          };
        },
      });
    },
  },
  {
    name: "Tedious",
    create(checkout, release, setup) {
      return createTediousPoolProvider(
        {
          async acquire() {
            checkout();
            return {
              execSql() {},
              beginTransaction() {},
              commitTransaction() {},
              rollbackTransaction() {},
              saveTransaction() {},
              release,
            };
          },
        },
        {
          get maxBufferedRows() {
            setup();
            return 16;
          },
        },
      );
    },
  },
  ...(["postgres", "mysql", "mariadb"] as const).map((dialect) => ({
    name: `bun-sql-${dialect}`,
    create(checkout: () => void, release: () => Promise<void>, setup: () => void) {
      const client = (() => Promise.resolve([])) as unknown as BunSqlClient;
      client.unsafe = async <T>() => [] as T;
      client.reserve = async () => {
        checkout();
        const reserved = (() => Promise.resolve([])) as unknown as BunSqlReservedClient;
        Object.defineProperty(reserved, "unsafe", {
          get() {
            setup();
            return async () => [];
          },
        });
        reserved.release = release;
        return reserved;
      };
      return createBunSqlProvider(client, { dialect });
    },
  })),
];

for (const fixture of providers) {
  const id = ({ PostgreSQL: "pg", Tedious: "tedious", MariaDB: "mariadb" } as Record<string, string>)[fixture.name] ?? fixture.name;
  const nativeInit = id.startsWith("bun-sql-") ? ` [contract:${id}:resource.init-failure:boundary]` : "";
  test(`[contract:${id}:pool.checkout-init-failure:boundary]${nativeInit} [ownership:pooled] ${fixture.name} releases every failed initialization and preserves its original error`, async () => {
    const primary = new Error("executor setup failed");
    let acquired = 0;
    let released = 0;
    const provider = fixture.create(
      () => {
        acquired += 1;
      },
      async () => {
        released += 1;
      },
      () => {
        throw primary;
      },
    );
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await assert.rejects(provider.acquire(), (error: unknown) => error === primary);
    }
    assert.equal(acquired, 3);
    assert.equal(released, acquired);
  });

  test(`[contract:${id}:pool.checkout-init-failure:boundary] [ownership:pooled] ${fixture.name} preserves initialization and cleanup errors without retrying cleanup`, async () => {
    const primary = new Error("executor setup failed");
    const cleanup = new Error("physical release failed");
    let acquired = 0;
    let releaseAttempts = 0;
    let returned = 0;
    const provider = fixture.create(
      () => {
        acquired += 1;
      },
      async () => {
        releaseAttempts += 1;
        throw cleanup;
      },
      () => {
        throw primary;
      },
    );
    const results = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      results.push(
        await provider.acquire().then(
          () => {
            returned += 1;
          },
          (error: unknown) => error,
        ),
      );
    }
    assert.equal(acquired, 3);
    assert.equal(returned, 0);
    assert.equal(releaseAttempts, acquired);
    for (const error of results) {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.ok("code" in error);
      assert.equal(error.code, "BRAID_RESOURCE_CLEANUP");
    }
  });

  test(`${fixture.name} transfers cleanup ownership only to successful leases`, async () => {
    let acquired = 0;
    let released = 0;
    const provider = fixture.create(
      () => {
        acquired += 1;
      },
      async () => {
        released += 1;
      },
      () => undefined,
    );
    const leases = [];
    for (let iteration = 0; iteration < 3; iteration += 1) leases.push(await provider.acquire());
    assert.equal(acquired, 3);
    assert.equal(released, 0);
    for (const lease of leases) {
      assert.equal(lease.statementBinding, provider.statementBinding);
      await lease.release();
      await lease.release();
    }
    assert.equal(released, acquired);
  });
}

for (const name of ["PostgreSQL", "mysql2"]) {
  test(`${name} rejects invalid stream configuration before physical checkout`, async () => {
    let acquired = 0;
    const unexpectedCheckout = async (): Promise<never> => {
      acquired += 1;
      throw new Error("invalid configuration reached checkout");
    };
    for (let iteration = 0; iteration < 3; iteration += 1) {
      await assert.rejects(async () => {
        const provider =
          name === "PostgreSQL"
            ? createPgPoolProvider({ connect: unexpectedCheckout }, { streamBatchSize: 0 })
            : createMysql2PoolProvider({ getConnection: unexpectedCheckout }, { streamHighWaterMark: 0 });
        await provider.acquire();
      }, RangeError);
    }
    assert.equal(acquired, 0);
  });
}
