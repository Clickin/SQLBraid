import type { CommandResult, DatabaseOptions, TypePolicy } from "@sqlbraid/core";
import type { MariaDbProfileOptions, MariaDbRepresentationProfile } from "../type-policy.js";
export type {
  MariaDbConnectionOptions,
  MariaDbJsonProfile,
  MariaDbProfileOptions,
  MariaDbRepresentationProfile,
  MariaDbTemporalProfile,
} from "../type-policy.js";

export interface MariaDbFieldLike {
  readonly name?: string | (() => string);
  readonly type?: string;
  readonly columnType?: number;
  readonly columnLength?: number;
  readonly scale?: number;
  readonly isDataTypeFormatJson?: () => boolean;
}

export interface MariaDbRowSet extends ReadonlyArray<unknown> {
  readonly meta?: readonly MariaDbFieldLike[];
}

export interface MariaDbCommandResult extends CommandResult {
  readonly warningStatus?: number;
}

export interface MariaDbStreamLike extends AsyncIterable<unknown> {
  close?(): void | Promise<void>;
  on?(event: string, listener: (...args: readonly unknown[]) => void): this;
  once?(event: string, listener: (...args: readonly unknown[]) => void): this;
}

export type MariaDbParameter = unknown;

/** Connector/Node.js query options required by the adapter's row/metadata normalization. */
export interface MariaDbQueryOptions {
  readonly sql: string;
  readonly rowsAsArray?: boolean;
  readonly metaAsArray?: boolean;
  readonly insertIdAsNumber?: boolean;
}

export interface MariaDbConnectionLike {
  execute(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): Promise<unknown>;
  query?(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): Promise<unknown>;
  queryStream?(sql: string | MariaDbQueryOptions, values?: readonly MariaDbParameter[]): MariaDbStreamLike;
  batch?(sql: string | MariaDbQueryOptions, values: readonly (readonly MariaDbParameter[])[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  getConnection?: never;
  destroy?(): void;
  end?(): void | Promise<void>;
}

export interface MariaDbPoolConnectionLike extends MariaDbConnectionLike {
  release(): void | Promise<void>;
}

export interface MariaDbPoolLike {
  getConnection(): Promise<MariaDbPoolConnectionLike>;
}

/** MariaDB executor policy. Exact numerics stay textual in the lossless profile; streaming uses native connector APIs. */
export interface MariaDbExecutorOptions {
  readonly typePolicy?: TypePolicy;
  /**
   * Declarative evidence for the Connector/Node.js result-shaping options.
   * The connector does not expose effective options on physical connections.
   */
  readonly profile?: MariaDbProfileOptions | MariaDbRepresentationProfile;
}

export type MariaDbDatabaseOptions = DatabaseOptions & MariaDbExecutorOptions;

export const fieldTypes: Readonly<Record<number, string>> = {
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
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINYTEXT",
  250: "TEXT",
  251: "MEDIUMTEXT",
  252: "BLOB",
  253: "VARCHAR",
  254: "CHAR",
  255: "GEOMETRY",
};
