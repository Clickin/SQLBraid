export const SQL_FRAGMENT = Symbol.for("sqlbraid.fragment");

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface RenderLimits {
  readonly maxSqlBytes?: number;
  readonly maxBindCount?: number;
  readonly maxStructuralItems?: number;
  readonly maxNestingDepth?: number;
}

export type QueryResultKind = "rows" | "command" | "call" | "unknown";

export interface RenderedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly { readonly placeholder: number; readonly interpolation?: number }[];
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
  readonly resultKind?: QueryResultKind;
}

export interface DialectLexicalProfile {
  readonly lineCommentPrefixes: readonly string[];
  readonly supportsNestedBlockComments?: boolean;
  readonly supportsDollarQuotes?: boolean;
  readonly supportsBacktickIdentifiers?: boolean;
  readonly supportsBracketIdentifiers?: boolean;
  readonly backslashEscapes?: boolean;
}

export interface Dialect {
  readonly id: string;
  placeholder(index: number): string;
  quoteIdentifier(identifier: string): string;
  readonly lexicalProfile?: DialectLexicalProfile;
}

export interface TypeMapping {
  readonly databaseType: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly nullable: boolean;
}

export interface TypePolicy {
  readonly id: string;
  readonly hash: string;
  readonly mappings: readonly TypeMapping[];
  decode(databaseType: string, value: unknown): unknown;
  encode(databaseType: string, value: unknown): unknown;
}

export interface TextNode {
  readonly kind: "text";
  readonly text: string;
  readonly range: SourceRange;
}

export interface BindNode {
  readonly kind: "bind";
  readonly interpolation: number;
  readonly range: SourceRange;
}

export interface FragmentNode {
  readonly kind: "fragment";
  readonly fragment: SqlFragment;
  readonly range: SourceRange;
}

export interface IdentifierNode {
  readonly kind: "identifier";
  readonly value: string | readonly string[];
  readonly range: SourceRange;
}

export interface RawNode {
  readonly kind: "raw";
  readonly text: string;
  readonly range: SourceRange;
}

export interface ListNode {
  readonly kind: "list";
  readonly values: readonly unknown[];
  readonly range: SourceRange;
}

export interface IfNode {
  readonly kind: "if";
  readonly condition: number;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface ChooseWhen {
  readonly condition: number;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface ChooseNode {
  readonly kind: "choose";
  readonly whens: readonly ChooseWhen[];
  readonly otherwise?: readonly TemplateNode[];
  readonly range: SourceRange;
}

export interface TrimAttributes {
  readonly prefix: string;
  readonly prefixOverrides: readonly string[];
  readonly suffix: string;
  readonly suffixOverrides: readonly string[];
}

export interface TrimNode {
  readonly kind: "trim";
  readonly attributes: TrimAttributes;
  readonly children: readonly TemplateNode[];
  readonly range: SourceRange;
}

export type TemplateNode =
  | TextNode
  | BindNode
  | FragmentNode
  | IdentifierNode
  | RawNode
  | ListNode
  | IfNode
  | ChooseNode
  | TrimNode;

export interface TemplateIr {
  readonly version: 1;
  readonly nodes: readonly TemplateNode[];
  readonly sourceLength: number;
}

export interface SqlFragment {
  readonly [SQL_FRAGMENT]: true;
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly dialectId: string;
}

export interface Query<Row = unknown, Kind extends QueryResultKind = "unknown"> {
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly resultKind: Kind;
  render(): RenderedQuery;
  readonly __row?: Row;
}

export type RowQuery<Row = unknown> = Query<Row, "rows">;
export type CommandQuery<Result = CommandResult> = Query<Result, "command">;
export type CallQuery<Row = unknown> = Query<Row, "call">;

export interface CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint | string;
  readonly [key: string]: unknown;
}

export interface QueryExecutionResult<Row = unknown> {
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly kind?: "rows" | "command";
  readonly command?: CommandResult;
}

export interface RoutineResultSet<Row = unknown> {
  readonly rows: readonly Row[] | "unknown";
}

export interface RoutineCallResult<Row = unknown> {
  readonly output: Readonly<Record<string, unknown>>;
  readonly resultSets: readonly RoutineResultSet<Row>[];
}

export interface QueryExecutor {
  /** Stable identity for the physical execution resource shared by wrappers; pools must use a leased resource. */
  readonly ownershipKey?: object;
  query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>>;
  stream?<Row>(rendered: RenderedQuery, signal?: AbortSignal): AsyncIterable<Row>;
  call?<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>>;
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(name: string): Promise<void>;
  rollbackTo?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}

export interface PreparedQuery<Row> {
  readonly name: string;
  execute(): Promise<QueryExecutionResult<Row>>;
  all(): Promise<readonly Row[]>;
  one(): Promise<Row>;
  maybeOne(): Promise<Row | undefined>;
}

export interface Database {
  all<Row>(query: RowQuery<Row>): Promise<readonly Row[]>;
  one<Row>(query: RowQuery<Row>): Promise<Row>;
  maybeOne<Row>(query: RowQuery<Row>): Promise<Row | undefined>;
  execute<Result, Kind extends QueryResultKind>(query: Query<Result, Kind>): Promise<QueryExecutionResult<Result>>;
  call<Row>(query: CallQuery<Row>): Promise<RoutineCallResult<Row>>;
  batch<const Queries extends readonly Query<unknown, QueryResultKind>[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: QueryExecutionResult<QueryRow<Queries[K]>> }>;
  prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row>;
  stream<Row>(query: RowQuery<Row>, options?: { readonly signal?: AbortSignal }): AsyncIterable<Row>;
  transaction<T>(callback: (database: Database) => Promise<T>): Promise<T>;
}

export type QueryRow<Q> = Q extends Query<infer Row, QueryResultKind> ? Row : never;
export type QueryResult<Q> = readonly QueryRow<Q>[];

export interface SqlTagLike {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, QueryResultKind>;
}

export interface SqlTag extends SqlTagLike {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, "unknown">;
  <Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
  rows: {
    <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
  };
  command: {
    <Result = CommandResult>(strings: TemplateStringsArray, ...values: readonly unknown[]): CommandQuery<Result>;
  };
  call: {
    <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<Row>;
  };
  fragment: (strings: TemplateStringsArray, ...values: readonly unknown[]) => SqlFragment;
  empty: SqlFragment;
  ident: (identifier: string | readonly string[]) => SqlFragment;
  raw: (text: string) => SqlFragment;
  join: (items: readonly SqlFragment[], separator?: SqlFragment) => SqlFragment;
  list: (values: readonly unknown[]) => SqlFragment;
}

export class SqlRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SqlRenderError";
    this.code = code;
  }
}
