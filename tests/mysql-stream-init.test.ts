import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createMysql2Executor,
  type Mysql2ConnectionLike,
  type Mysql2RawConnectionLike,
  type Mysql2RawStreamLike,
} from "@sqlbraid/mysql/mysql2";
import { sql } from "@sqlbraid/mysql";

function contains(error: unknown, expected: unknown): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError) return error.errors.some((nested) => contains(nested, expected));
  return error instanceof Error && "cause" in error && contains(error.cause, expected);
}

function fakeConnection(config: {
  readonly execute: () => { readonly stream: () => Mysql2RawStreamLike } | never;
  readonly rawDestroy?: () => void;
}): Mysql2ConnectionLike & { readonly connection: Mysql2RawConnectionLike } {
  let rawStreamDestroyed = false;
  const rawStream = {
    get destroyed() {
      return rawStreamDestroyed;
    },
    destroy() {
      rawStreamDestroyed = true;
    },
  };
  const raw: Mysql2RawConnectionLike = {
    execute: () => config.execute(),
    destroy: () => config.rawDestroy?.(),
    stream: rawStream,
  };
  return {
    connection: raw,
    execute: async () => [[], []] as const,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
  };
}

function firstNext(connection: Mysql2ConnectionLike): Promise<IteratorResult<unknown>> {
  const iterator = createMysql2Executor(connection)
    .stream(sql.rows`SELECT ${1}`.render())
    [Symbol.asyncIterator]();
  return iterator.next();
}

test("mysql2 stream setup preserves raw execute errors without inventing ownership", async () => {
  const primary = new Error("execute init failure");
  let destroyed = 0;
  const connection = fakeConnection({
    execute: () => {
      throw primary;
    },
    rawDestroy: () => {
      destroyed += 1;
    },
  });

  await assert.rejects(firstNext(connection), (error: unknown) => error === primary);
  assert.equal(destroyed, 0);
});

test("mysql2 stream setup destroys the physical resource when command.stream fails", async () => {
  const primary = new Error("stream init failure");
  let destroyed = 0;
  const connection = fakeConnection({
    execute: () => ({
      stream: () => {
        throw primary;
      },
    }),
    rawDestroy: () => {
      destroyed += 1;
    },
  });

  await assert.rejects(
    firstNext(connection),
    (error: unknown) =>
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === "BRAID_RESOURCE_CLEANUP" &&
      contains(error, primary),
  );
  assert.equal(destroyed, 1);
});

test("mysql2 stream setup destroys source and physical resource when iterator creation fails", async () => {
  const primary = new Error("iterator init failure");
  let rawDestroyed = 0;
  let sourceDestroyed = 0;
  const source: Mysql2RawStreamLike = {
    get destroyed() {
      return sourceDestroyed > 0;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    [Symbol.asyncIterator]() {
      throw primary;
    },
    destroy() {
      sourceDestroyed += 1;
      return this;
    },
  };
  const connection = fakeConnection({
    execute: () => ({ stream: () => source }),
    rawDestroy: () => {
      rawDestroyed += 1;
    },
  });

  await assert.rejects(
    firstNext(connection),
    (error: unknown) =>
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === "BRAID_RESOURCE_CLEANUP" &&
      contains(error, primary),
  );
  assert.equal(sourceDestroyed, 1);
  assert.equal(rawDestroyed, 1);
});

test("mysql2 stream setup retains primary and cleanup failures", async () => {
  const primary = new Error("iterator init failure");
  const cleanupFailure = new Error("raw destroy failure");
  let sourceDestroyed = false;
  const source: Mysql2RawStreamLike = {
    get destroyed() {
      return sourceDestroyed;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    [Symbol.asyncIterator]() {
      throw primary;
    },
    destroy() {
      sourceDestroyed = true;
      return this;
    },
  };
  const connection = fakeConnection({
    execute: () => ({ stream: () => source }),
    rawDestroy: () => {
      throw cleanupFailure;
    },
  });

  await assert.rejects(
    firstNext(connection),
    (error: unknown) =>
      error instanceof Error &&
      (error as { readonly code?: unknown }).code === "BRAID_RESOURCE_CLEANUP" &&
      contains(error, primary) &&
      contains(error, cleanupFailure),
  );
});
