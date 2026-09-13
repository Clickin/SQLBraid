import type { StandardSchemaV1 } from "@standard-schema/spec";

export type { StandardSchemaV1 } from "@standard-schema/spec";

export const SQL_FRAGMENT = Symbol.for("sqlbraid.fragment");

const SQL_BOUND_PARAMETER = Symbol.for("sqlbraid.bound-parameter");
const knownBoundParameters = new WeakSet<object>();
declare const boundParameterBrand: unique symbol;

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

/**
 * A rendered parameter is always a value. Adapters MUST NOT interpret it as
 * raw SQL, an identifier, a nested query, a driver-specific fragment, or a
 * structural tagged-template command.
 */
export interface RenderedParameter {
  readonly value: unknown;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
}

export interface RenderedStatement {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly dialectId: string;
  readonly resultKind: QueryResultKind;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}

export interface ParameterTypeHint<Input = unknown> {
  readonly databaseType: string;
  readonly length?: number | "max";
  readonly precision?: number;
  readonly scale?: number;
  readonly __input?: Input;
}

export interface BoundParameter<Input = unknown> {
  readonly value: Input;
  readonly hint: ParameterTypeHint<Input>;
  readonly [boundParameterBrand]: true;
}

function validHintNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function validHintInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isParameterTypeHint(value: unknown): value is ParameterTypeHint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly databaseType?: unknown; readonly length?: unknown; readonly precision?: unknown; readonly scale?: unknown };
  return typeof candidate.databaseType === "string"
    && candidate.databaseType.trim().length > 0
    && (candidate.length === undefined || candidate.length === "max" || validHintNumber(candidate.length))
    && (candidate.precision === undefined || validHintNumber(candidate.precision))
    && (candidate.scale === undefined || validHintInteger(candidate.scale));
}

export function createParameterTypeHint<Input = unknown>(hint: ParameterTypeHint<Input>): ParameterTypeHint<Input> {
  if (!isParameterTypeHint(hint)) throw new TypeError("sql.bind hint must be an object with valid structural fields.");
  const candidate = hint as { readonly databaseType?: unknown; readonly length?: unknown; readonly precision?: unknown; readonly scale?: unknown };
  if (typeof candidate.databaseType !== "string" || !candidate.databaseType.trim()) throw new TypeError("sql.bind hint databaseType must be a non-empty string.");
  if (candidate.length !== undefined && candidate.length !== "max" && !validHintNumber(candidate.length)) throw new TypeError("sql.bind hint length must be a non-negative integer or \"max\".");
  if (candidate.precision !== undefined && !validHintNumber(candidate.precision)) throw new TypeError("sql.bind hint precision must be a non-negative integer.");
  if (candidate.scale !== undefined && !validHintInteger(candidate.scale)) throw new TypeError("sql.bind hint scale must be an integer.");
  const normalized = {
    databaseType: candidate.databaseType,
    ...(candidate.length === undefined ? {} : { length: candidate.length }),
    ...(candidate.precision === undefined ? {} : { precision: candidate.precision }),
    ...(candidate.scale === undefined ? {} : { scale: candidate.scale }),
  } as ParameterTypeHint<Input>;
  return Object.freeze(normalized);
}

export function createBoundParameter<Input>(
  value: NoInfer<Input>,
  hint: ParameterTypeHint<Input>,
): BoundParameter<Input> {
  const normalizedHint = createParameterTypeHint(hint);
  const bound = Object.freeze({ value, hint: normalizedHint, [SQL_BOUND_PARAMETER]: true });
  knownBoundParameters.add(bound);
  return bound as unknown as BoundParameter<Input>;
}

export function isBoundParameter(value: unknown): value is BoundParameter {
  if (typeof value !== "object" || value === null || !knownBoundParameters.has(value) || !Object.hasOwn(value, SQL_BOUND_PARAMETER)) return false;
  const candidate = value as { readonly value?: unknown; readonly hint?: unknown; readonly [SQL_BOUND_PARAMETER]?: unknown };
  return candidate[SQL_BOUND_PARAMETER] === true
    && Object.hasOwn(candidate, "value")
    && isParameterTypeHint(candidate.hint);
}

export type ParameterTransportKind =
  | "native-value-template"
  | "text-positional"
  | "text-named"
  | "typed-request";

export type RequestedReuse = "auto" | "simple" | "reuse";
export type EffectiveReuse = "simple" | "reuse";
export type ReuseOwner = "sqlbraid" | "driver" | "server";

export interface StatementBindingContext {
  readonly dialectId: string;
  readonly requestedReuse: RequestedReuse;
  readonly preparedName?: string;
}

export interface BindingDescription {
  readonly index: number;
  readonly name?: string;
  readonly interpolation?: number;
  readonly hint?: ParameterTypeHint;
}

export interface LiteralizeOptions {
  readonly values?: "inline" | "redacted";
  readonly maxValueLength?: number;
  readonly binary?: "summary" | "full";
  readonly redact?: (parameter: RenderedParameter, index: number) => boolean;
}

export interface LiteralizedSqlResult {
  readonly text: string;
  readonly complete: boolean;
  readonly redactedParameters: number;
  readonly truncatedParameters: number;
}

export interface StatementBindingDescription {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly parameterizedSql?: string;
  readonly bindings: readonly BindingDescription[];
  readonly reuse: {
    readonly requested: RequestedReuse;
    readonly effective: EffectiveReuse;
    readonly owner: ReuseOwner;
    readonly capacity?: number;
  };
  /** Diagnostic reconstruction only; never use this text as execution input. */
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
}

export interface StatementBindingAdapter {
  readonly id: string;
  describe(statement: RenderedStatement, context: StatementBindingContext): StatementBindingDescription;
}

export interface StatementBindingDescriptionOptions {
  readonly adapterId: string;
  readonly transport: ParameterTransportKind;
  readonly placeholder?: (index: number) => string;
  readonly reuse: {
    readonly effective: EffectiveReuse;
    readonly owner: ReuseOwner;
    readonly capacity?: number;
  };
  readonly formatLiteral?: (parameter: RenderedParameter, index: number, options: LiteralizeOptions) => string | undefined;
}

const knownRenderedStatements = new WeakSet<object>();

function copyRenderedParameter(parameter: RenderedParameter): RenderedParameter {
  if (typeof parameter !== "object" || parameter === null || Array.isArray(parameter)) {
    throw new TypeError("RenderedStatement parameters must be parameter records.");
  }
  const candidate = parameter as { readonly value?: unknown; readonly interpolation?: unknown; readonly hint?: unknown };
  if (!Object.hasOwn(candidate, "value")) throw new TypeError("RenderedStatement parameters must contain a value.");
  const interpolation = candidate.interpolation;
  if (interpolation !== undefined && !validHintNumber(interpolation)) {
    throw new TypeError("RenderedStatement parameter interpolation must be a non-negative integer.");
  }
  const hint = candidate.hint === undefined ? undefined : createParameterTypeHint(candidate.hint as ParameterTypeHint);
  return Object.freeze({
    value: candidate.value,
    ...(interpolation === undefined ? {} : { interpolation }),
    ...(hint === undefined ? {} : { hint }),
  });
}

export function createRenderedStatement(statement: {
  readonly segments: readonly string[];
  readonly parameters: readonly RenderedParameter[];
  readonly resultKind: QueryResultKind;
  readonly dialectId: string;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
}): RenderedStatement {
  if (typeof statement !== "object" || statement === null) throw new TypeError("RenderedStatement must be an object.");
  if (knownRenderedStatements.has(statement)) return statement as RenderedStatement;
  if (!Array.isArray(statement.segments)) {
    throw new TypeError("RenderedStatement segments must be an array of strings.");
  }
  if (!Array.isArray(statement.parameters)) throw new TypeError("RenderedStatement parameters must be an array.");
  if (statement.segments.length !== statement.parameters.length + 1) {
    throw new TypeError("RenderedStatement invariant violated: segments.length must equal parameters.length + 1.");
  }
  if (typeof statement.dialectId !== "string" || !statement.dialectId) throw new TypeError("RenderedStatement dialectId must be a non-empty string.");
  const segments = Object.freeze([...statement.segments]);
  if (segments.some((segment) => typeof segment !== "string")) throw new TypeError("RenderedStatement segments must be an array of strings.");
  const parameters = Object.freeze(Array.from(statement.parameters, copyRenderedParameter));
  const rendered = Object.freeze({
    segments,
    parameters,
    dialectId: statement.dialectId,
    resultKind: statement.resultKind,
    ...(statement.fingerprint === undefined ? {} : { fingerprint: statement.fingerprint }),
    ...(statement.variantFingerprint === undefined ? {} : { variantFingerprint: statement.variantFingerprint }),
  });
  knownRenderedStatements.add(rendered);
  return rendered;
}

export function parameterizedSql(statement: RenderedStatement, placeholder: (index: number) => string): string {
  const parts: string[] = [statement.segments[0] ?? ""];
  for (let index = 0; index < statement.parameters.length; index += 1) {
    parts.push(placeholder(index + 1), statement.segments[index + 1] ?? "");
  }
  return parts.join("");
}

function genericLiteral(parameter: RenderedParameter, dialectId: string, binary: "summary" | "full"): string {
  const value = parameter.value;
  if (value === null) return "NULL";
  if (value === undefined) return "[undefined]";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") {
    if (/^(?:mysql|sqlite)/i.test(dialectId) || /^(?:oracle|mssql|sqlserver)/i.test(dialectId)) return value ? "1" : "0";
    if (/^(?:postgres|postgresql|cockroach|redshift)/i.test(dialectId)) return value ? "TRUE" : "FALSE";
    return `[boolean ${value ? "true" : "false"}]`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `[unsupported ${String(value)}]`;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    try {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isNaN(timestamp) ? "[unsupported date]" : `[date ${Date.prototype.toISOString.call(value)}]`;
    } catch {
      return "[unsupported date]";
    }
  }
  if (value instanceof Uint8Array) {
    try {
      if (binary === "full") {
        let hex = "";
        for (const byte of value) hex += byte.toString(16).padStart(2, "0");
        return `X'${hex}'`;
      }
      return `[binary ${value.byteLength} bytes]`;
    } catch {
      return "[unsupported binary]";
    }
  }
  if (typeof value === "object") return "[unsupported object]";
  return `[unsupported ${typeof value}]`;
}

function literalized(
  statement: RenderedStatement,
  dialectId: string,
  formatLiteral: StatementBindingDescriptionOptions["formatLiteral"],
  options: LiteralizeOptions | undefined,
): LiteralizedSqlResult {
  const resolved: LiteralizeOptions = options ?? {};
  const valuesMode = resolved.values ?? "redacted";
  const maxLength = resolved.maxValueLength;
  if (valuesMode !== "inline" && valuesMode !== "redacted") throw new TypeError("literalizedSql values must be \"inline\" or \"redacted\".");
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0)) {
    throw new TypeError("literalizedSql maxValueLength must be a non-negative integer.");
  }
  const binary = resolved.binary ?? "summary";
  if (binary !== "summary" && binary !== "full") throw new TypeError("literalizedSql binary must be \"summary\" or \"full\".");
  if (resolved.redact !== undefined && typeof resolved.redact !== "function") throw new TypeError("literalizedSql redact must be a function.");
  const parts: string[] = [statement.segments[0] ?? ""];
  let redactedParameters = 0;
  let truncatedParameters = 0;
  for (let index = 0; index < statement.parameters.length; index += 1) {
    const parameter = statement.parameters[index];
    const redact = valuesMode === "redacted" || resolved.redact?.(parameter, index) === true;
    let valueText: string;
    if (redact) {
      valueText = "[REDACTED]";
      redactedParameters += 1;
    } else {
      valueText = formatLiteral?.(parameter, index, resolved) ?? genericLiteral(parameter, dialectId, binary);
    }
    if (maxLength !== undefined && valueText.length > maxLength) {
      valueText = maxLength === 0 ? "" : valueText.slice(0, maxLength);
      truncatedParameters += 1;
    }
    parts.push(valueText, statement.segments[index + 1] ?? "");
  }
  return Object.freeze({
    text: parts.join(""),
    complete: truncatedParameters === 0,
    redactedParameters,
    truncatedParameters,
  });
}

export function createStatementBindingDescription(
  statement: RenderedStatement,
  context: StatementBindingContext,
  options: StatementBindingDescriptionOptions,
): StatementBindingDescription {
  const logical = createRenderedStatement(statement);
  const adapterId = options.adapterId;
  const transport = options.transport;
  const placeholder = options.placeholder;
  const formatLiteral = options.formatLiteral;
  const effective = options.reuse.effective;
  const owner = options.reuse.owner;
  const capacity = options.reuse.capacity;
  const dialectId = context.dialectId;
  const requestedReuse = context.requestedReuse;
  if (typeof adapterId !== "string" || !adapterId) throw new TypeError("Statement binding adapterId must be a non-empty string.");
  if (typeof dialectId !== "string" || !dialectId) throw new TypeError("Statement binding dialectId must be a non-empty string.");
  if (!["native-value-template", "text-positional", "text-named", "typed-request"].includes(transport)) {
    throw new TypeError("Statement binding transport is unsupported.");
  }
  if (transport !== "native-value-template" && placeholder === undefined) {
    throw new TypeError("Text and typed statement transports require a placeholder function.");
  }
  if (!["auto", "simple", "reuse"].includes(requestedReuse)) throw new TypeError("Statement binding requestedReuse is unsupported.");
  if (!["simple", "reuse"].includes(effective) || !["sqlbraid", "driver", "server"].includes(owner)) {
    throw new TypeError("Statement binding reuse policy is unsupported.");
  }
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 0)) {
    throw new TypeError("Statement binding reuse capacity must be a non-negative safe integer.");
  }
  if (placeholder !== undefined && typeof placeholder !== "function") {
    throw new TypeError("Statement binding placeholder must be a function.");
  }
  const bindings = Object.freeze(logical.parameters.map((parameter, offset) => Object.freeze({
    index: offset + 1,
    ...(parameter.interpolation === undefined ? {} : { interpolation: parameter.interpolation }),
    ...(parameter.hint === undefined ? {} : { hint: createParameterTypeHint(parameter.hint) }),
  })));
  const reuse = Object.freeze({
    requested: requestedReuse,
    effective,
    owner,
    ...(capacity === undefined ? {} : { capacity }),
  });
  let parameterizedReady = false;
  let parameterized: string | undefined;
  const literalCache = new Map<string, LiteralizedSqlResult>();
  let defaultLiteralized: LiteralizedSqlResult | undefined;
  const description = {
    adapterId,
    dialectId,
    transport,
    bindings,
    reuse,
    literalizedSql: (literalOptions?: LiteralizeOptions): LiteralizedSqlResult => {
      if (literalOptions === undefined) {
        if (defaultLiteralized === undefined) defaultLiteralized = literalized(logical, dialectId, formatLiteral, undefined);
        return defaultLiteralized;
      }
      if (typeof literalOptions !== "object" || literalOptions === null) throw new TypeError("literalizedSql options must be an object.");
      const values = literalOptions.values;
      const binary = literalOptions.binary;
      const maxValueLength = literalOptions.maxValueLength;
      const redact = literalOptions.redact;
      const snapshot = Object.freeze({
        ...(values === undefined ? {} : { values }),
        ...(binary === undefined ? {} : { binary }),
        ...(maxValueLength === undefined ? {} : { maxValueLength }),
        ...(redact === undefined ? {} : { redact }),
      });
      const cacheKey = redact === undefined
        ? `${values ?? ""}\u0000${binary ?? ""}\u0000${maxValueLength ?? ""}`
        : undefined;
      if (cacheKey !== undefined) {
        const cached = literalCache.get(cacheKey);
        if (cached) return cached;
      }
      const result = literalized(logical, dialectId, formatLiteral, snapshot);
      if (cacheKey !== undefined) literalCache.set(cacheKey, result);
      return result;
    },
  } as StatementBindingDescription;
  if (placeholder !== undefined) {
    Object.defineProperty(description, "parameterizedSql", {
      enumerable: true,
      configurable: false,
      get: () => {
        if (!parameterizedReady) {
          parameterized = parameterizedSql(logical, placeholder);
          parameterizedReady = true;
        }
        return parameterized;
      },
    });
  }
  return Object.freeze(description);
}

export interface DialectLexicalProfile {
  readonly lineCommentPrefixes: readonly string[];
  readonly supportsNestedBlockComments?: boolean;
  readonly supportsDollarQuotes?: boolean;
  readonly supportsBacktickIdentifiers?: boolean;
  readonly supportsBracketIdentifiers?: boolean;
  readonly supportsOracleQQuotes?: boolean;
  readonly backslashEscapes?: boolean;
}

export interface Dialect {
  readonly id: string;
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
  /**
   * Application result mapper. Never forwarded to a DB driver.
   */
  readonly resultSchema?: StandardSchemaV1<unknown, Row>;
  render(): RenderedStatement;
  readonly __row?: Row;
}

export type RowQuery<Row = unknown> = Query<Row, "rows">;
export type CommandQuery = Query<CommandResult, "command">;
export type CallQuery<Row = unknown> = Query<Row, "call">;

export interface CommandResult {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint | string;
  readonly [key: string]: unknown;
}

export interface RowsExecutionResult<Row = unknown> {
  readonly kind: "rows";
  readonly rows: readonly Row[];
  readonly rowCount?: number;
  readonly command?: never;
}

export interface CommandExecutionResult {
  readonly kind: "command";
  readonly rows: readonly [];
  readonly rowCount?: number;
  readonly command: CommandResult;
}

export type QueryExecutionResult<Row = unknown> =
  | RowsExecutionResult<Row>
  | CommandExecutionResult;

export interface RowValidationOptions<Row> {
  readonly schema?: StandardSchemaV1<unknown, NoInfer<Row>>;
}

export interface StreamOptions<Row> extends RowValidationOptions<Row> {
  readonly signal?: AbortSignal;
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
  readonly statementBinding: StatementBindingAdapter;
  query<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<QueryExecutionResult<Row>>;
  stream?<Row>(rendered: RenderedStatement, signal?: AbortSignal, binding?: StatementBindingDescription): AsyncIterable<Row>;
  call?<Row>(rendered: RenderedStatement, binding?: StatementBindingDescription): Promise<RoutineCallResult<Row>>;
  begin?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  savepoint?(name: string): Promise<void>;
  rollbackTo?(name: string): Promise<void>;
  releaseSavepoint?(name: string): Promise<void>;
}

export interface ConnectionLease extends QueryExecutor {
  release(options?: { readonly discard?: boolean }): void | Promise<void>;
}

export interface ConnectionProvider {
  readonly statementBinding: StatementBindingAdapter;
  acquire(): Promise<ConnectionLease>;
}

export interface QueryExecutionPlan {
  readonly adapterId: string;
  readonly dialectId: string;
  readonly transport: ParameterTransportKind;
  readonly reuse: StatementBindingDescription["reuse"];
}

export interface QueryReadyEvent {
  readonly type: "query:ready";
  readonly operationId: string;
  readonly batchId?: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly { readonly placeholder: number; readonly interpolation?: number }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: QueryResultKind;
  readonly fingerprint?: string;
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export interface QueryResultEvent {
  readonly type: "query:result";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly actualKind: "rows" | "command" | "call";
  readonly rowCount?: number;
  readonly command?: Readonly<Record<string, unknown>>;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export interface QueryMappedEvent {
  readonly type: "query:mapped";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly queryMapped: boolean;
  readonly executionMapped: boolean;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type QueryErrorStage =
  | "render"
  | "observer-before"
  | "materialize"
  | "acquire"
  | "driver"
  | "result-kind"
  | "cardinality"
  | "query-map"
  | "execution-map"
  | "observer-after"
  | "release"
  | "stream"
  | "transaction";

export interface QueryErrorEvent {
  readonly type: "query:error";
  readonly operationId: string;
  readonly preparedName?: string;
  readonly batchId?: string;
  readonly error: unknown;
  readonly stage: QueryErrorStage;
  readonly executionStarted: boolean;
  readonly executionCompleted: boolean;
  readonly durationMs?: number;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export interface StreamStartEvent {
  readonly type: "stream:start";
  readonly operationId: string;
  readonly sql?: string;
  readonly values: readonly unknown[];
  readonly bindingMap?: readonly { readonly placeholder: number; readonly interpolation?: number }[];
  readonly parameterHints?: readonly (ParameterTypeHint | undefined)[];
  readonly execution: QueryExecutionPlan;
  readonly literalizedSql: (options?: LiteralizeOptions) => LiteralizedSqlResult;
  readonly declaredKind: "rows";
  readonly variantFingerprint?: string;
  readonly preparedName?: string;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export interface StreamEndEvent {
  readonly type: "stream:end";
  readonly operationId: string;
  readonly status: "completed" | "error";
  readonly durationMs: number;
  readonly rowCount: number;
  readonly error?: unknown;
  readonly transactionDepth: number;
  readonly transactionScoped: boolean;
}

export type TransactionEventPhase =
  | "begin"
  | "commit"
  | "rollback"
  | "savepoint"
  | "rollback-to-savepoint"
  | "release-savepoint";

export interface TransactionEvent {
  readonly type: "transaction";
  readonly transactionId: string;
  readonly phase: TransactionEventPhase;
  readonly status: "requested" | "completed" | "failed";
  readonly depth: number;
  readonly savepointName?: string;
  readonly durationMs?: number;
  readonly error?: unknown;
}

export type ExecutionEvent =
  | QueryReadyEvent
  | QueryResultEvent
  | QueryMappedEvent
  | QueryErrorEvent
  | StreamStartEvent
  | StreamEndEvent
  | TransactionEvent;

export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
}

export interface DatabaseOptions {
  readonly observers?: readonly ExecutionObserver[];
  readonly reuse?: RequestedReuse;
}

export interface PreparedQuery<Row> {
  readonly name: string;
  execute(): Promise<RowsExecutionResult<Row>>;
  all(options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  one(options?: RowValidationOptions<Row>): Promise<Row>;
  maybeOne(options?: RowValidationOptions<Row>): Promise<Row | undefined>;
}

export type ExecutableQuery =
  | RowQuery<unknown>
  | Query<unknown, "command">
  | Query<unknown, "unknown">;

export type ExecutionResultOf<Q> =
  Q extends RowQuery<infer Row>
    ? RowsExecutionResult<Row>
    : Q extends Query<unknown, "command">
      ? CommandExecutionResult
      : Q extends Query<infer Row, "unknown">
        ? QueryExecutionResult<Row>
        : never;

export interface Database {
  all<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<readonly Row[]>;
  one<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row>;
  maybeOne<Row>(query: RowQuery<Row>, options?: RowValidationOptions<Row>): Promise<Row | undefined>;
  execute<Q extends ExecutableQuery>(query: Q): Promise<ExecutionResultOf<Q>>;
  call<Row>(query: CallQuery<Row>): Promise<RoutineCallResult<Row>>;
  batch<const Queries extends readonly ExecutableQuery[]>(queries: Queries): Promise<{ readonly [K in keyof Queries]: ExecutionResultOf<Queries[K]> }>;
  prepare<Row>(name: string, factory: () => RowQuery<Row>): PreparedQuery<Row>;
  stream<Row>(query: RowQuery<Row>, options?: StreamOptions<Row>): AsyncIterable<Row>;
  tx<T>(callback: (database: Database) => Promise<T>): Promise<T>;
}

export type QueryRow<Q> = Q extends Query<infer Row, QueryResultKind> ? Row : never;

export interface SqlTagLike<Kind extends QueryResultKind = QueryResultKind, Row = unknown> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row, Kind>;
}

export interface RowsTag {
  // Two type parameters keep this overload out of the sql.rows<Row> instantiation expression.
  <Input, Output>(schema: StandardSchemaV1<Input, Output>): SqlTagLike<"rows", Output>;
  <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
}

export interface SqlTag extends SqlTagLike<"unknown"> {
  rows: RowsTag;
  command: (strings: TemplateStringsArray, ...values: readonly unknown[]) => CommandQuery;
  call: {
    <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<Row>;
  };
  bind<Input>(value: NoInfer<Input>, hint: ParameterTypeHint<Input>): BoundParameter<Input>;
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
