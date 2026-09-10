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

export interface RenderedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}

export interface Dialect {
  readonly id: string;
  placeholder(index: number): string;
  quoteIdentifier(identifier: string): string;
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
}

export interface Query<Row = unknown> {
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  render(): RenderedQuery;
  readonly __row?: Row;
}

export interface QueryExecutionResult<Row = unknown> {
  readonly rows: readonly Row[];
  readonly rowCount?: number;
}

export interface RoutineResultSet<Row = unknown> {
  readonly rows: readonly Row[] | "unknown";
}

export interface RoutineCallResult<Row = unknown> {
  readonly output: Readonly<Record<string, unknown>>;
  readonly resultSets: readonly RoutineResultSet<Row>[];
}

export interface QueryExecutor {
  query<Row>(rendered: RenderedQuery): Promise<QueryExecutionResult<Row>>;
  call?<Row>(rendered: RenderedQuery): Promise<RoutineCallResult<Row>>;
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export interface Database<Row = unknown> {
  all<Q extends Query<Row>>(query: Q): Promise<readonly Row[]>;
  one<Q extends Query<Row>>(query: Q): Promise<Row>;
  maybeOne<Q extends Query<Row>>(query: Q): Promise<Row | undefined>;
  execute<Q extends Query<Row>>(query: Q): Promise<QueryExecutionResult<Row>>;
  call<Q extends Query<Row>>(query: Q): Promise<RoutineCallResult<Row>>;
  batch<Q extends Query<Row>>(queries: readonly Q[]): Promise<readonly QueryExecutionResult<Row>[]>;
  transaction<T>(callback: (database: Database<Row>) => Promise<T>): Promise<T>;
}

export type QueryRow<Q> = Q extends Query<infer Row> ? Row : never;
export type QueryResult<Q> = readonly QueryRow<Q>[];

export interface SqlTag<Row = unknown> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row>;
  <Contract>(strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Contract>;
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
