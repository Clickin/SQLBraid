import type { DatabaseOptions, TypePolicy } from "@sqlbraid/core";

/** One column of a PGlite result. `dataTypeID` is the PostgreSQL type OID. */
export interface PgliteFieldLike {
  readonly name: string;
  readonly dataTypeID: number;
}

export interface PgliteResultLike {
  readonly rows: readonly unknown[];
  readonly fields?: readonly PgliteFieldLike[];
  readonly affectedRows?: number;
  readonly command?: string;
}

export interface PgliteQueryOptionsLike {
  readonly rowMode?: "array" | "object";
  readonly parsers?: Readonly<Record<number, (value: string) => unknown>>;
}

/** The part of a `PGlite` instance that the adapter uses. */
export interface PgliteLike {
  query(text: string, params?: readonly unknown[], options?: PgliteQueryOptionsLike): Promise<PgliteResultLike>;
}

/** PGlite executor policy. Only the lossless text representation is supported. */
export interface PgliteExecutorOptions {
  readonly typePolicy?: TypePolicy;
}

export type PgliteDatabaseOptions = DatabaseOptions & PgliteExecutorOptions;
