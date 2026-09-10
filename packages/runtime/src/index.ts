import type { CallQuery, Database, PreparedQuery, Query, QueryExecutionResult, QueryExecutor, QueryResultKind, QueryRow, RoutineCallResult, RowQuery } from "@sqlbraid/core";

export class DatabaseCardinalityError extends Error {
  readonly expected: "one" | "maybeOne";
  readonly actual: number;

  constructor(expected: "one" | "maybeOne", actual: number) {
    super(`Expected ${expected === "one" ? "exactly one" : "at most one"} row, received ${actual}.`);
    this.name = "DatabaseCardinalityError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class DatabaseScopeError extends Error {
  readonly code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED";

  constructor(code: "BRAID_TX_SCOPE" | "BRAID_TX_CLOSED", message: string) {
    super(message);
    this.name = "DatabaseScopeError";
    this.code = code;
  }
}

export class DatabaseResultError extends Error {
  readonly code = "BRAID_RESULT_KIND";

  constructor(message: string) {
    super(message);
    this.name = "DatabaseResultError";
  }
}

interface ScopeState {
  active: boolean;
  idle: Promise<void>;
  release?: () => void;
}

interface DatabaseOptions {
  readonly transaction?: boolean;
  readonly preparedNames: Set<string>;
}

interface ScopedDatabase extends Database {
  close(): void;
}

function cleanupError(error: unknown, cleanup: unknown): unknown {
  if (cleanup === undefined) return error;
  return new AggregateError([error, cleanup], "Transaction failed and cleanup also failed.");
}

export function createDatabase(executor: QueryExecutor): Database {
  return createScopedDatabase(executor, { active: false, idle: Promise.resolve() }, { transaction: false, preparedNames: new Set<string>() });
}

function createScopedDatabase(executor: QueryExecutor, state: ScopeState, options: DatabaseOptions): ScopedDatabase {
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new DatabaseScopeError("BRAID_TX_CLOSED", "Transaction database is no longer usable.");
  };
  const waitForUse = async (): Promise<void> => {
    assertOpen();
    if (!options.transaction && state.active) await state.idle;
    assertOpen();
  };

  const database: ScopedDatabase = {
    async execute<Result, Kind extends QueryResultKind>(query: Query<Result, Kind>): Promise<QueryExecutionResult<Result>> {
      await waitForUse();
      return executor.query<Result>(query.render());
    },
    async call<Row>(query: CallQuery<Row>): Promise<RoutineCallResult<Row>> {
      await waitForUse();
      if (!executor.call) throw new Error("Executor does not support routine calls.");
      return executor.call<Row>(query.render());
    },
    async all<Row>(query: RowQuery<Row>): Promise<readonly Row[]> {
      const result = await database.execute<Row, "rows">(query);
      if (result.kind === "command" || result.command !== undefined) throw new DatabaseResultError("A command result cannot be read as rows.");
      return result.rows;
    },
    async one<Row>(query: RowQuery<Row>): Promise<Row> {
      const rows = await database.all(query);
      if (rows.length !== 1) throw new DatabaseCardinalityError("one", rows.length);
      return rows[0];
    },
    async maybeOne<Row>(query: RowQuery<Row>): Promise<Row | undefined> {
      const rows = await database.all(query);
      if (rows.length > 1) throw new DatabaseCardinalityError("maybeOne", rows.length);
      return rows[0];
    },
    async batch<const Queries extends readonly Query<unknown, QueryResultKind>[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: QueryExecutionResult<QueryRow<Queries[K]>> }> {
      await waitForUse();
      const results: QueryExecutionResult<unknown>[] = [];
      for (const query of queries) results.push(await executor.query<unknown>(query.render()));
      return results as { readonly [K in keyof Queries]: QueryExecutionResult<QueryRow<Queries[K]>> };
    },
    prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row> {
      if (!name.trim()) throw new Error("BRAID_PREPARED_NAME: prepared query name must not be empty.");
      if (options.preparedNames.has(name)) throw new Error(`BRAID_PREPARED_NAME: duplicate prepared query name ${name}.`);
      options.preparedNames.add(name);
      let shape: string | undefined;
      const current = (): RowQuery<Row> => {
        const query = factory();
        const rendered = query.render();
        const nextShape = `${query.resultKind}:${rendered.text}`;
        if (shape === undefined) shape = nextShape;
        else if (shape !== nextShape) throw new Error(`BRAID_PREPARED_SHAPE: prepared query ${name} changed its rendered structure.`);
        return query;
      };
      return {
        name,
        execute: async () => database.execute(current()),
        all: async () => database.all(current()),
        one: async () => database.one(current()),
        maybeOne: async () => database.maybeOne(current()),
      };
    },
    stream<Row>(query: RowQuery<Row>, options: { readonly signal?: AbortSignal } = {}): AsyncIterable<Row> {
      const streamExecutor = executor.stream;
      if (!streamExecutor) throw new Error("BRAID_STREAM_UNSUPPORTED: this adapter does not expose a streaming protocol.");
      return (async function* (): AsyncGenerator<Row> {
        await waitForUse();
        const rendered = query.render();
        const source = streamExecutor<Row>(rendered, options.signal);
        for await (const row of source) {
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("Stream aborted.");
          yield row;
        }
      })();
    },
    async transaction<T>(callback: (transactionDatabase: Database) => Promise<T>): Promise<T> {
      if (options.transaction) {
        await waitForUse();
        if (!executor.savepoint || !executor.rollbackTo || !executor.releaseSavepoint) throw new DatabaseScopeError("BRAID_TX_SCOPE", "Nested transactions require savepoint support.");
        const name = `braid_sp_${Math.random().toString(36).slice(2)}`;
        await executor.savepoint(name);
        const nested = createScopedDatabase(executor, state, { transaction: true, preparedNames: options.preparedNames });
        try {
          const result = await callback(nested);
          await executor.releaseSavepoint(name);
          return result;
        } catch (error) {
          try { await executor.rollbackTo(name); } catch (cleanup) { throw cleanupError(error, cleanup); }
          throw error;
        } finally {
          nested.close();
        }
      }
      await waitForUse();
      if (!executor.begin || !executor.commit || !executor.rollback) throw new Error("Executor does not support transactions.");
      state.active = true;
      state.idle = new Promise<void>((resolve) => { state.release = resolve; });
      const transactionDatabase = createScopedDatabase(executor, state, { transaction: true, preparedNames: options.preparedNames });
      let begun = false;
      try {
        await executor.begin();
        begun = true;
        const result = await callback(transactionDatabase);
        await executor.commit();
        return result;
      } catch (error) {
        if (!begun) throw error;
        try { await executor.rollback(); } catch (cleanup) { throw cleanupError(error, cleanup); }
        throw error;
      } finally {
        state.active = false;
        state.release?.();
        state.release = undefined;
        transactionDatabase.close();
      }
    },
    close(): void {
      closed = true;
    },
  };
  return database;
}
