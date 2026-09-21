import {
  SQL_FRAGMENT,
  SqlRenderError,
  createBoundParameter,
  createRoutineInOutParameter,
  createRoutineOutParameter,
  type Dialect,
  type ParameterTypeHint,
  type Query,
  type QueryResultKind,
  type RenderLimits,
  type RoutineContract,
  type StandardSchemaV1,
  type SqlFragment,
  type SqlTag,
  type SqlTagLike,
  type TemplateIr,
  type TemplateNode,
} from "@sqlbraid/core";
import {
  DEFAULT_LEXICAL_PROFILE,
  isFragment,
  isTemplateStringsArray,
  knownFragments,
  postgresDialect,
} from "./lexical.js";
import { cachedTemplate, freezeNode, freezeTemplateIr, validateNativeTemplate } from "./parser.js";
import { renderIr, renderPlainTemplate, validateLimits } from "./render.js";

export function makeFragment(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  dialect: Dialect,
  limits: RenderLimits,
): SqlFragment {
  const fragment = {
    [SQL_FRAGMENT]: true as const,
    ir: cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth),
    values: Object.freeze([...values]),
    dialectId: dialect.id,
  };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

export function makeStaticFragment(
  nodes: readonly TemplateNode[],
  sourceLength: number,
  dialect: Dialect,
): SqlFragment {
  const fragment = {
    [SQL_FRAGMENT]: true as const,
    ir: Object.freeze({ version: 1 as const, nodes: Object.freeze(nodes.map(freezeNode)), sourceLength }),
    values: Object.freeze([]),
    dialectId: dialect.id,
  };
  knownFragments.add(fragment);
  return Object.freeze(fragment);
}

/** Configuration captured by a SQL tag; dialect and limits become immutable tag-local policy. */
export interface SqlTagOptions {
  readonly dialect?: Dialect;
  readonly limits?: RenderLimits;
}

function assertStandardSchema(value: unknown): asserts value is StandardSchemaV1<unknown, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("sql.rows(schema) requires a Standard Schema object.");
  }
  const standard = (value as { readonly "~standard"?: unknown })["~standard"];
  if (typeof standard !== "object" || standard === null) {
    throw new TypeError("sql.rows(schema) requires a Standard Schema object.");
  }
  const protocol = standard as { readonly version?: unknown; readonly validate?: unknown };
  if (protocol.version !== 1 || typeof protocol.validate !== "function") {
    throw new TypeError("sql.rows(schema) requires a Standard Schema v1 object.");
  }
}

function normalizeRoutineContract(value: RoutineContract): RoutineContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("sql.call(contract) requires a routine contract object.");
  }
  const contract = value as {
    readonly output?: unknown;
    readonly resultSets?: unknown;
    readonly returnValue?: unknown;
    readonly procedure?: unknown;
  };
  if (contract.output !== undefined) assertStandardSchema(contract.output);
  if (contract.resultSets !== undefined) {
    if (!Array.isArray(contract.resultSets)) throw new TypeError("sql.call(contract).resultSets must be an array.");
    for (const schema of contract.resultSets) assertStandardSchema(schema);
  }
  if (contract.returnValue !== undefined) assertStandardSchema(contract.returnValue);
  let procedure: RoutineContract["procedure"];
  if (contract.procedure !== undefined) {
    if (typeof contract.procedure !== "object" || contract.procedure === null || Array.isArray(contract.procedure)) {
      throw new TypeError("sql.call(contract).procedure must be an object.");
    }
    const candidate = contract.procedure as { readonly name?: unknown; readonly parameterNames?: unknown };
    if (typeof candidate.name !== "string" || !candidate.name.trim())
      throw new TypeError("Routine procedure name must be a non-empty string.");
    if (
      !Array.isArray(candidate.parameterNames) ||
      candidate.parameterNames.some((name) => typeof name !== "string" || !name.trim())
    ) {
      throw new TypeError("Routine procedure parameterNames must contain non-empty strings.");
    }
    if (new Set(candidate.parameterNames).size !== candidate.parameterNames.length) {
      throw new TypeError("Routine procedure parameterNames must be unique.");
    }
    procedure = Object.freeze({
      name: candidate.name,
      parameterNames: Object.freeze([...candidate.parameterNames]),
    });
  }
  return Object.freeze({
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.resultSets === undefined ? {} : { resultSets: Object.freeze([...value.resultSets]) }),
    ...(value.returnValue === undefined ? {} : { returnValue: value.returnValue }),
    ...(procedure === undefined ? {} : { procedure }),
  });
}

type PreparedQueryFactory = (
  strings: TemplateStringsArray,
  values: readonly unknown[],
  preparsedIr?: TemplateIr,
) => Query<unknown, QueryResultKind>;
export const preparedQueryFactories = new WeakMap<object, PreparedQueryFactory>();

/** Create a dialect-bound SQL tag whose structural policy and limits remain stable for its lifetime. */
export function createSqlTag(options: SqlTagOptions = {}): SqlTag {
  const dialect = options.dialect ?? postgresDialect;
  const limits = validateLimits(options.limits ?? {});
  const nativeTemplateOwner = {};
  const createQuery = <Row, Kind extends QueryResultKind>(
    strings: TemplateStringsArray,
    values: readonly unknown[],
    resultKind: Kind,
    resultSchema?: StandardSchemaV1<unknown, Row>,
    routineContract?: RoutineContract,
    preparsedIr?: TemplateIr,
  ): Query<Row, Kind> => {
    const captured = Object.freeze([...values]);
    let ir = preparsedIr === undefined ? undefined : freezeTemplateIr(preparsedIr);
    const getIr = (): TemplateIr => {
      if (ir === undefined) ir = cachedTemplate(strings, dialect.lexicalProfile, limits.maxNestingDepth);
      return ir;
    };
    const structural =
      preparsedIr !== undefined || strings.some((segment) => segment.includes("/*@braid")) || captured.some(isFragment);
    if (!structural) validateNativeTemplate(strings, dialect.lexicalProfile ?? DEFAULT_LEXICAL_PROFILE);
    const query = {
      get ir() {
        return getIr();
      },
      values: captured,
      resultKind,
      ...(resultSchema === undefined ? {} : { resultSchema }),
      ...(routineContract === undefined ? {} : { routineContract }),
      render: () =>
        structural
          ? renderIr(getIr(), captured, dialect, limits, resultKind, routineContract?.procedure, nativeTemplateOwner)
          : renderPlainTemplate(
              strings,
              captured,
              dialect,
              limits,
              resultKind,
              routineContract?.procedure,
              nativeTemplateOwner,
            ),
    } as Query<Row, Kind>;
    return Object.freeze(query);
  };
  const createUnknown = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "unknown">(strings, values, "unknown", undefined, undefined, preparsedIr);
  const tag = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, "unknown"> =>
    createUnknown(strings, values)) as SqlTag;
  preparedQueryFactories.set(tag, createUnknown);
  const createRows = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "rows">(strings, values, "rows", undefined, undefined, preparsedIr);
  tag.rows = ((first: TemplateStringsArray | StandardSchemaV1, ...values: readonly unknown[]) => {
    if (isTemplateStringsArray(first)) return createRows(first, values);
    assertStandardSchema(first);
    const schema = first;
    const rowTag = ((strings: TemplateStringsArray, ...tagValues: readonly unknown[]) =>
      createQuery(strings, tagValues, "rows", schema)) as SqlTagLike<"rows", unknown>;
    preparedQueryFactories.set(rowTag, (strings, tagValues, preparsedIr) =>
      createQuery(strings, tagValues, "rows", schema, undefined, preparsedIr),
    );
    return rowTag;
  }) as SqlTag["rows"];
  preparedQueryFactories.set(tag.rows, createRows);
  const createCommand = (strings: TemplateStringsArray, values: readonly unknown[], preparsedIr?: TemplateIr) =>
    createQuery<unknown, "command">(strings, values, "command", undefined, undefined, preparsedIr);
  tag.command = ((strings: TemplateStringsArray, ...values: readonly unknown[]): Query<unknown, "command"> =>
    createCommand(strings, values)) as SqlTag["command"];
  preparedQueryFactories.set(tag.command, createCommand);
  tag.call = ((first: TemplateStringsArray | RoutineContract, ...values: readonly unknown[]) => {
    if (isTemplateStringsArray(first)) return createQuery(first, values, "call");
    const contract = normalizeRoutineContract(first);
    const callTag = ((strings: TemplateStringsArray, ...tagValues: readonly unknown[]) =>
      createQuery(strings, tagValues, "call", undefined, contract)) as SqlTag["call"];
    preparedQueryFactories.set(callTag, (strings, tagValues, preparsedIr) =>
      createQuery(strings, tagValues, "call", undefined, contract, preparsedIr),
    );
    return callTag;
  }) as SqlTag["call"];
  tag.bind = ((value: unknown, hint: ParameterTypeHint) => createBoundParameter(value, hint)) as SqlTag["bind"];
  tag.out = ((name: string, hint?: ParameterTypeHint) => createRoutineOutParameter(name, hint)) as SqlTag["out"];
  tag.inOut = ((name: string, value: unknown, hint?: ParameterTypeHint) =>
    createRoutineInOutParameter(name, value, hint)) as SqlTag["inOut"];
  tag.fragment = (strings, ...values) => makeFragment(strings, values, dialect, limits);
  tag.empty = makeStaticFragment([], 0, dialect);
  tag.ident = (identifier) =>
    makeStaticFragment(
      [
        {
          kind: "identifier",
          value: typeof identifier === "string" ? identifier : Object.freeze([...identifier]),
          range: { start: 0, end: 0 },
        },
      ],
      0,
      dialect,
    );
  tag.raw = (text) =>
    makeStaticFragment([{ kind: "raw", text, range: { start: 0, end: text.length } }], text.length, dialect);
  tag.join = (items, separator = tag.empty) => {
    if (!items.every(isFragment) || !isFragment(separator))
      throw new SqlRenderError("BRAID_FRAGMENT", "sql.join accepts SQLBraid fragments only.");
    const nodes: TemplateNode[] = [];
    items.forEach((item, index) => {
      if (item.dialectId !== dialect.id || separator.dialectId !== dialect.id)
        throw new SqlRenderError("BRAID_DIALECT", "Cannot join fragments from another dialect.");
      if (index) nodes.push({ kind: "fragment", fragment: separator, range: { start: 0, end: 0 } });
      nodes.push({ kind: "fragment", fragment: item, range: { start: 0, end: 0 } });
    });
    return makeStaticFragment(nodes, 0, dialect);
  };
  tag.list = (values) => {
    if (!Array.isArray(values)) throw new SqlRenderError("BRAID_LIST", "sql.list requires an array.");
    for (let index = 0; index < values.length; index += 1)
      if (!Object.hasOwn(values, index))
        throw new SqlRenderError("BRAID_LIST", "sql.list does not accept sparse arrays.");
    if (values.some(isFragment))
      throw new SqlRenderError(
        "BRAID_LIST",
        "sql.list accepts bind values only; use sql.join for structural fragments.",
      );
    if (!values.length)
      throw new SqlRenderError(
        "BRAID_EMPTY_LIST",
        "sql.list([]) has no implicit SQL meaning; guard it or choose an explicit empty strategy.",
      );
    return makeStaticFragment(
      [{ kind: "list", values: Object.freeze([...values]), range: { start: 0, end: 0 } }],
      0,
      dialect,
    );
  };
  return tag;
}

/** Default PostgreSQL-profile SQL tag. Use createSqlTag() for another dialect or limit set. */
export const sql = createSqlTag();
