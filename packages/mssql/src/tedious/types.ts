import type {
  BulkBindingDescription,
  DatabaseOptions,
  RenderedBulk,
  RenderedStatement,
  StatementBindingAdapter,
  StatementBindingDescription,
  TypePolicy,
} from "@sqlbraid/core";

export interface TediousColumnMetadataLike {
  readonly colName?: string;
  readonly name?: string;
  readonly type?: { readonly name?: string } | string;
  readonly precision?: number;
  readonly scale?: number;
  readonly dataLength?: number;
}

export interface TediousColumnLike {
  readonly value?: unknown;
  readonly metadata?: TediousColumnMetadataLike;
}

export interface TediousRequestLike {
  on(event: string, listener: (...args: any[]) => void): this;
  once?(event: string, listener: (...args: any[]) => void): this;
  removeListener?(event: string, listener: (...args: any[]) => void): this;
  addParameter(
    name: string,
    type: unknown,
    value?: unknown,
    options?: { readonly length?: number; readonly precision?: number; readonly scale?: number },
  ): void;
  addOutputParameter?(
    name: string,
    type: unknown,
    value?: unknown,
    options?: { readonly length?: number; readonly precision?: number; readonly scale?: number },
  ): void;
  cancel?(): void;
  pause?(): void;
  resume?(): void;
}

export interface TediousConnectionLike {
  execSql(request: TediousRequestLike): void;
  prepare?(request: TediousRequestLike): void;
  execute?(request: TediousRequestLike, parameters: Record<string, unknown>): void;
  unprepare?(request: TediousRequestLike): void;
  callProcedure?(request: TediousRequestLike): void;
  readonly beginTransaction: (...args: any[]) => void;
  readonly commitTransaction: (...args: any[]) => void;
  readonly rollbackTransaction: (...args: any[]) => void;
  readonly saveTransaction: (...args: any[]) => void;
  cancel?(): void;
  close?(): void | Promise<void>;
}

export interface TediousPoolConnectionLike extends TediousConnectionLike {
  release(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}

export interface TediousPoolLike {
  acquire?(): Promise<TediousPoolConnectionLike>;
  connect?(): Promise<TediousPoolConnectionLike>;
  getConnection?(): Promise<TediousPoolConnectionLike>;
}

/** SQL Server database options; exact numeric output is text and native `OUTPUT` owns write-returning semantics. */
export type TediousDatabaseOptions = DatabaseOptions & {
  readonly typePolicy?: TypePolicy;
  readonly maxBufferedRows?: number;
};

/** Tedious executor policy, including the optional custom TypePolicy. */
export type TediousExecutorOptions = {
  readonly typePolicy?: TypePolicy;
  readonly maxBufferedRows?: number;
};

export interface TediousMaterializedParameter {
  readonly name: string;
  readonly databaseType: DatabaseType;
  readonly type: unknown;
  readonly value: unknown;
  readonly options?: { readonly length?: number; readonly precision?: number; readonly scale?: number };
  readonly direction: "in" | "out" | "inout";
  readonly outputName?: string;
}

export interface TediousStatementBindingAdapter extends StatementBindingAdapter {
  readonly materializedParameters: (
    statement: RenderedStatement,
    description: StatementBindingDescription,
  ) => readonly TediousMaterializedParameter[] | undefined;
  readonly materializedBulkParameters: (
    bulk: RenderedBulk,
    description: BulkBindingDescription,
  ) => readonly (readonly TediousMaterializedParameter[])[] | undefined;
}

/** Binding options for SQL Server type hints and representation policy. */
export interface TediousStatementBindingOptions {
  readonly typePolicy?: TypePolicy;
}

export type DatabaseType =
  | "tinyint"
  | "smallint"
  | "int"
  | "bigint"
  | "decimal"
  | "numeric"
  | "money"
  | "smallmoney"
  | "real"
  | "float"
  | "bit"
  | "nvarchar"
  | "varchar"
  | "char"
  | "varbinary"
  | "binary"
  | "uniqueidentifier"
  | "date"
  | "datetime2"
  | "datetimeoffset";

export const typeNames: Readonly<Record<DatabaseType, string>> = {
  tinyint: "TinyInt",
  smallint: "SmallInt",
  int: "Int",
  bigint: "BigInt",
  decimal: "Decimal",
  numeric: "Numeric",
  money: "Money",
  smallmoney: "SmallMoney",
  real: "Real",
  float: "Float",
  bit: "Bit",
  nvarchar: "NVarChar",
  varchar: "VarChar",
  char: "Char",
  varbinary: "VarBinary",
  binary: "Binary",
  uniqueidentifier: "UniqueIdentifier",
  date: "Date",
  datetime2: "DateTime2",
  datetimeoffset: "DateTimeOffset",
};
