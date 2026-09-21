import type { DatabaseOptions, TypePolicy } from "@sqlbraid/core";
import type { PgJsonProfile, PgRepresentationProfile, PgTemporalProfile } from "../type-policy.js";

export interface PgFieldLike {
  readonly name: string;
  readonly dataTypeID?: number;
  readonly dataType?: string;
}

export interface PgTypeOverrides {
  getTypeParser(oid: number, format?: string): (value: string) => unknown;
}

export interface PgResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
  readonly fields?: readonly PgFieldLike[];
  readonly command?: string;
}

export interface PgClientLike {
  query(config: {
    readonly text: string;
    readonly values: readonly unknown[];
    readonly name?: string;
    readonly types?: PgTypeOverrides;
  }): Promise<PgResultLike>;
  query(text: string, values?: readonly unknown[]): Promise<PgResultLike>;
  /**
   * Physical node-postgres clients expose these helpers; pools do not.
   * They are the public discriminator that keeps pool usage on the lease API.
   */
  escapeIdentifier(value: string): string;
  escapeLiteral(value: string): string;
  getTypeParser?(oid: number, format?: string): (value: string) => unknown;
  /** Required when streaming with an AbortSignal; ends the physical connection. */
  end?(): Promise<void>;
}

export interface PgPoolClientLike extends PgClientLike {
  release(destroy?: boolean): void | Promise<void>;
}

export interface PgPoolLike {
  connect(): Promise<PgPoolClientLike>;
}

export interface PgCursorLike {
  read(rowCount: number, callback: (error: unknown, rows?: readonly unknown[], result?: PgResultLike) => void): void;
  close(callback: (error?: unknown) => void): void;
}

/** Native cursor constructor used to implement `db.stream()`; the optional peer keeps materialized queries usable without it. */
export interface PgCursorFactory {
  new (text: string, values: readonly unknown[], config?: { readonly types?: PgTypeOverrides }): PgCursorLike;
}

/** Parser overrides must agree with the selected representation profile when both are supplied. */
export interface PgParserProfile {
  readonly json?: PgJsonProfile;
  readonly temporal?: PgTemporalProfile;
}

/**
 * PostgreSQL executor policy. Exact numerics remain text by default; `cursor` is required for native streaming.
 * `parserProfile` changes pg type parsers and is rejected when it contradicts `profile`.
 */
export interface PgExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly profile?: PgRepresentationProfile;
  readonly streamBatchSize?: number;
  readonly cursor?: PgCursorFactory;
  readonly parserProfile?: PgParserProfile;
}

export type PgDatabaseOptions = DatabaseOptions & PgExecutorOptions;

export const pgOidTypes: Readonly<Record<number, string>> = Object.freeze({
  16: "bool",
  17: "bytea",
  18: "char",
  19: "name",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  790: "money",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamp with time zone",
  1186: "interval",
  1266: "time with time zone",
  1700: "numeric",
  2950: "uuid",
  3802: "jsonb",
  700: "float4",
  701: "float8",
  791: "money[]",
  1000: "bool[]",
  1001: "bytea[]",
  1002: "char[]",
  1003: "name[]",
  1005: "int2[]",
  1007: "int4[]",
  1009: "text[]",
  1014: "bpchar[]",
  1015: "varchar[]",
  1016: "int8[]",
  1021: "float4[]",
  1022: "float8[]",
  1028: "oid[]",
  1182: "date[]",
  1183: "time[]",
  1185: "timestamp with time zone[]",
  1187: "interval[]",
  1231: "numeric[]",
  1270: "time with time zone[]",
  199: "json[]",
  2951: "uuid[]",
  3807: "jsonb[]",
  143: "xml[]",
});
