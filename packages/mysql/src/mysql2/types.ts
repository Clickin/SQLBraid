import type { CommandResult, DatabaseOptions, TypePolicy } from "@sqlbraid/core";
import type { Mysql2ProfileOptions, Mysql2RepresentationProfile } from "../type-policy.js";
export type {
  Mysql2ConnectionOptions,
  Mysql2JsonProfile,
  Mysql2ProfileOptions,
  Mysql2RepresentationProfile,
  Mysql2TemporalProfile,
} from "../type-policy.js";

export interface Mysql2FieldLike {
  readonly name?: string;
  readonly type?: string | number;
}
export type Mysql2FieldPayload = readonly Mysql2FieldLike[] | readonly (readonly Mysql2FieldLike[])[];

export type Mysql2ResultHeader = Omit<CommandResult, "affectedRows" | "insertId"> & {
  readonly affectedRows?: unknown;
  readonly insertId?: unknown;
  readonly warningStatus?: unknown;
};

type Mysql2TypedParameter = { readonly type: number; readonly value: unknown; readonly unsigned: boolean };
export type Mysql2Parameter =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | Blob
  | Uint8Array
  | Mysql2TypedParameter
  | Mysql2Parameter[]
  | { [key: string]: Mysql2Parameter };

/**
 * mysql2 execute request shape used by prepared and streaming paths.
 * `rowsAsArray` keeps field metadata authoritative for column-name/type normalization.
 */
export interface Mysql2ExecuteOptionsLike {
  readonly sql: string;
  readonly values?: Mysql2Parameter[];
  readonly rowsAsArray?: boolean;
  readonly disableEval?: boolean;
}

export interface Mysql2RawStreamLike extends AsyncIterable<unknown> {
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  destroy?(error?: Error): this;
  resume?(): this;
  on?(event: string, listener: (...args: readonly unknown[]) => void): this;
  once(event: string, listener: (...args: readonly unknown[]) => void): this;
}

export interface Mysql2RawCommandLike {
  stream(options?: { readonly highWaterMark?: number }): Mysql2RawStreamLike;
}

export interface Mysql2RawConnectionLike {
  execute(sqlOrOptions: string | Mysql2ExecuteOptionsLike, values?: Mysql2Parameter[]): Mysql2RawCommandLike;
  destroy(): void;
  readonly stream?: {
    readonly destroyed?: boolean;
    destroy(error?: Error): void;
  };
}

export interface Mysql2PreparedStatementLike {
  execute(values?: Mysql2Parameter[]): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  close(): Promise<void>;
}

export interface Mysql2ConnectionLike {
  execute(
    sqlOrOptions: string | Mysql2ExecuteOptionsLike,
    values?: Mysql2Parameter[],
  ): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  prepare?(sql: string): Promise<Mysql2PreparedStatementLike>;
  unprepare?(sql: string): void | Promise<void>;
  query?(sql: string): Promise<readonly [unknown, Mysql2FieldPayload | undefined]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
}

export interface Mysql2PoolConnectionLike extends Mysql2ConnectionLike {
  release(): void | Promise<void>;
  destroy(): void;
}

export interface Mysql2PoolLike {
  getConnection(): Promise<Mysql2PoolConnectionLike>;
}

/**
 * mysql2 connection/profile policy. Exact numeric fidelity depends on the selected representation profile;
 * active cancellation destroys the physical connection when the driver cannot safely interrupt it.
 */
export interface Mysql2ExecutorOptions {
  readonly typePolicy?: TypePolicy;
  readonly streamHighWaterMark?: number;
  /**
   * Optional evidence for connection options that mysql2 does not expose
   * consistently across PromiseConnection and PoolConnection wrappers.
   * Detected physical connection settings always take precedence.
   */
  readonly profile?: Mysql2ProfileOptions | Mysql2RepresentationProfile;
}

export type Mysql2DatabaseOptions = DatabaseOptions & Mysql2ExecutorOptions;

export const mysqlTypes: Readonly<Record<number, string>> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  14: "DATE",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "BLOB",
  250: "BLOB",
  251: "BLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "VARCHAR",
  255: "GEOMETRY",
};
