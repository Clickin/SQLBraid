import type { DatabaseOptions, TypePolicy } from "@sqlbraid/core";

/** One column of a postgres.js result. `type` is the PostgreSQL type OID. */
export interface PostgresJsColumnLike {
  readonly name: string;
  readonly type: number;
}

/** A postgres.js result list. In `values()` mode every row is an array. */
export interface PostgresJsResultLike extends ReadonlyArray<unknown> {
  readonly columns?: readonly PostgresJsColumnLike[] | null;
  readonly count?: number | null;
  readonly command?: string | null;
}

/** A pending `values()` query. It is awaitable and can run as a cursor. */
export interface PostgresJsValuesQueryLike extends PromiseLike<PostgresJsResultLike> {
  cursor(rows?: number): AsyncIterable<PostgresJsResultLike>;
}

/** A pending query from `unsafe()`. */
export interface PostgresJsQueryLike extends PromiseLike<PostgresJsResultLike> {
  values(): PostgresJsValuesQueryLike;
}

/** The part of a postgres.js reserved connection that the adapter uses. */
export interface PostgresJsReservedLike {
  unsafe(query: string, parameters?: readonly unknown[], options?: { readonly prepare?: boolean }): PostgresJsQueryLike;
  /** Marks a value with the OID of its PostgreSQL type. The adapter needs it only for a parameter type hint. */
  typed?(value: unknown, oid: number): unknown;
  release(): void | Promise<void>;
}

/** The part of a postgres.js `sql` instance that the adapter uses. */
export interface PostgresJsLike {
  reserve(): Promise<PostgresJsReservedLike>;
  unsafe(
    query: string,
    parameters?: readonly unknown[],
    options?: { readonly prepare?: boolean },
  ): PromiseLike<unknown>;
  readonly options: {
    readonly fetch_types?: boolean;
    readonly parsers: Readonly<Record<number, ((value: string) => unknown) | undefined>>;
  };
}

/** postgres.js executor policy. Only the lossless text representation is supported. */
export interface PostgresJsExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly streamBatchSize?: number;
}

export type PostgresJsDatabaseOptions = DatabaseOptions & PostgresJsExecutorOptions;
