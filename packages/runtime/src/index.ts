import type { Database, Query, QueryExecutionResult, QueryExecutor, RoutineCallResult } from "../../core/src/index.js";

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

export function createDatabase<Row = unknown>(executor: QueryExecutor): Database<Row> {
  const database: Database<Row> = {
    async execute(query: Query<Row>): Promise<QueryExecutionResult<Row>> {
      return executor.query<Row>(query.render());
    },
    async call(query: Query<Row>): Promise<RoutineCallResult<Row>> {
      if (!executor.call) throw new Error("Executor does not support routine calls.");
      return executor.call<Row>(query.render());
    },
    async all(query: Query<Row>): Promise<readonly Row[]> {
      return (await database.execute(query)).rows;
    },
    async one(query: Query<Row>): Promise<Row> {
      const rows = (await database.execute(query)).rows;
      if (rows.length !== 1) throw new DatabaseCardinalityError("one", rows.length);
      return rows[0];
    },
    async maybeOne(query: Query<Row>): Promise<Row | undefined> {
      const rows = (await database.execute(query)).rows;
      if (rows.length > 1) throw new DatabaseCardinalityError("maybeOne", rows.length);
      return rows[0];
    },
    async batch(queries: readonly Query<Row>[]): Promise<readonly QueryExecutionResult<Row>[]> {
      const results: QueryExecutionResult<Row>[] = [];
      for (const query of queries) results.push(await database.execute(query));
      return results;
    },
    async transaction<T>(callback: (transactionDatabase: Database<Row>) => Promise<T>): Promise<T> {
      if (!executor.begin || !executor.commit || !executor.rollback) throw new Error("Executor does not support transactions.");
      await executor.begin();
      try {
        const result = await callback(database);
        await executor.commit();
        return result;
      } catch (error) {
        await executor.rollback();
        throw error;
      }
    },
  };
  return database;
}
