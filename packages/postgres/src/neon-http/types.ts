import type { DatabaseOptions, TypePolicy } from "@sqlbraid/core";

export interface NeonHttpFieldLike {
  readonly name: string;
  readonly dataTypeID: number;
}

/** A Neon HTTP result with `fullResults: true` and `arrayMode: true`. */
export interface NeonHttpResultLike {
  readonly rows: readonly unknown[];
  readonly fields: readonly NeonHttpFieldLike[];
  readonly rowCount: number | null;
  readonly command?: string;
}

export interface NeonHttpTypesLike {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

/** Per-query options that the adapter passes to `sql.query()`. */
export interface NeonHttpQueryOptionsLike {
  readonly arrayMode: true;
  readonly fullResults: true;
  readonly types: NeonHttpTypesLike;
}

/**
 * A `neon()` query function. The Neon types change with the options, so this type accepts any function pair.
 * The adapter calls `query(text, params, options)` and `transaction(queries)` and checks the result shape.
 */
export interface NeonHttpLike {
  readonly query: (...args: never[]) => unknown;
  readonly transaction: (...args: never[]) => unknown;
}

/** The call shapes that the adapter uses on a `neon()` query function. */
export interface NeonHttpCalls {
  query(text: string, params: readonly unknown[], options: NeonHttpQueryOptionsLike): PromiseLike<unknown>;
  transaction(queries: readonly PromiseLike<unknown>[]): PromiseLike<readonly unknown[]>;
}

/** Neon HTTP executor policy. Only the lossless text representation is supported. */
export interface NeonHttpExecutorOptions {
  readonly typePolicy?: TypePolicy;
}

export type NeonHttpDatabaseOptions = DatabaseOptions & NeonHttpExecutorOptions;
