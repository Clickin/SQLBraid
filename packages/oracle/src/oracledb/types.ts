import type {
  BulkBindingDescription,
  DatabaseOptions,
  ParameterTypeHint,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingDescription,
  TypePolicy,
} from "@sqlbraid/core";

/** node-oracledb metadata surface used for type-policy decoding and duplicate-column checks. */
export interface OracleMetaDataLike {
  readonly name?: string;
  readonly dbType?: unknown;
  readonly dbTypeName?: string;
  readonly type?: unknown;
}

export interface OracleResultSetLike {
  readonly metaData?: readonly OracleMetaDataLike[];
  getRow?(): Promise<unknown | null | undefined>;
  getRows?(numRows?: number): Promise<readonly unknown[]>;
  close(): Promise<void> | void;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

export interface OracleLobLike {
  getData(): Promise<unknown>;
  destroy(error?: Error): unknown;
  once(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  readonly destroyed?: boolean;
  readonly closed?: boolean;
}

/** Materialized Oracle execution result; LOBs/result sets are consumed before lease release. */
export interface OracleExecuteResultLike {
  readonly rows?: readonly unknown[];
  readonly rowsAffected?: number;
  readonly metaData?: readonly OracleMetaDataLike[];
  readonly resultSet?: OracleResultSetLike;
  readonly outBinds?: unknown;
  readonly implicitResults?: readonly OracleResultSetLike[];
}

export interface OracleBindLike {
  readonly dir?: unknown;
  readonly val?: unknown;
  readonly type?: unknown;
  readonly maxSize?: number;
}

export interface OracleExecuteOptionsLike {
  readonly outFormat?: unknown;
  readonly fetchTypeHandler?: (
    metadata: OracleMetaDataLike,
  ) => { readonly type?: unknown; readonly converter?: (value: unknown) => unknown } | undefined;
  readonly resultSet?: boolean;
  readonly [key: string]: unknown;
}

export interface OracleConnectionLike {
  execute(sql: string, bindParams?: any, options?: any): Promise<unknown>;
  executeMany?(sql: string, binds: any, options?: any): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readonly stmtCacheSize?: number;
  break?(): Promise<void> | void;
  close?(options?: { readonly drop?: boolean }): Promise<void> | void;
}

export interface OraclePoolConnectionLike extends OracleConnectionLike {
  close(options?: { readonly drop?: boolean }): Promise<void> | void;
}

export interface OraclePoolLike {
  getConnection(): Promise<OraclePoolConnectionLike>;
  readonly stmtCacheSize?: number;
}

export interface OracleDriverLike {
  readonly BIND_IN?: unknown;
  readonly BIND_OUT?: unknown;
  readonly BIND_INOUT?: unknown;
  readonly OUT_FORMAT_OBJECT?: unknown;
  readonly OUT_FORMAT_ARRAY?: unknown;
  readonly STRING?: unknown;
  readonly NUMBER?: unknown;
  readonly DATE?: unknown;
  readonly BUFFER?: unknown;
  readonly BINARY_FLOAT?: unknown;
  readonly BINARY_DOUBLE?: unknown;
  readonly DB_TYPE_VARCHAR?: unknown;
  readonly DB_TYPE_CHAR?: unknown;
  readonly DB_TYPE_NVARCHAR?: unknown;
  readonly DB_TYPE_NCHAR?: unknown;
  readonly DB_TYPE_NUMBER?: unknown;
  readonly DB_TYPE_BINARY_FLOAT?: unknown;
  readonly DB_TYPE_BINARY_DOUBLE?: unknown;
  readonly DB_TYPE_DATE?: unknown;
  readonly DB_TYPE_TIMESTAMP?: unknown;
  readonly DB_TYPE_TIMESTAMP_TZ?: unknown;
  readonly DB_TYPE_TIMESTAMP_LTZ?: unknown;
  readonly DB_TYPE_RAW?: unknown;
  readonly DB_TYPE_BLOB?: unknown;
  readonly DB_TYPE_CLOB?: unknown;
  readonly DB_TYPE_NCLOB?: unknown;
  readonly DB_TYPE_ROWID?: unknown;
  readonly DB_TYPE_UROWID?: unknown;
  readonly DB_TYPE_JSON?: unknown;
  readonly DB_TYPE_OBJECT?: unknown;
  readonly DB_TYPE_VECTOR?: unknown;
  readonly BLOB?: unknown;
  readonly NCLOB?: unknown;
  readonly CURSOR?: unknown;
  readonly [key: string]: unknown;
}

/** Oracle adapter options, including Thin-mode type policy and native cancellation/stream settings. */
export interface OracleDatabaseOptions extends DatabaseOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
  readonly streamFetchSize?: number;
}

export interface OracleStatementBindingAdapter extends StatementBindingAdapter {
  readonly materializedBinds: (
    statement: RenderedStatement,
    description: StatementBindingDescription,
  ) => readonly unknown[] | undefined;
  readonly materializedBulk: (
    bulk: RenderedBulk,
    description: BulkBindingDescription,
  ) => { readonly binds: readonly (readonly unknown[])[]; readonly bindDefs: readonly OracleBindLike[] } | undefined;
}

/** Binding options for Oracle typed binds and explicit reuse policy. */
export interface OracledbStatementBindingOptions {
  readonly typePolicy?: TypePolicy;
  readonly driver?: OracleDriverLike;
  readonly executeOptions?: OracleExecuteOptionsLike;
  readonly stmtCacheSize?: number;
}

export interface OracleExecuteManyOptionsLike {
  readonly bindDefs?: readonly OracleBindLike[];
  readonly batchErrors?: boolean;
  readonly dmlRowCounts?: boolean;
  readonly [key: string]: unknown;
}

export interface OracleRoutineParameter {
  readonly value: unknown;
  readonly hint?: ParameterTypeHint;
  readonly direction?: "in" | "out" | "inout";
  readonly outputName?: string;
}
