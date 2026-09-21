import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ParameterTypeHint, BoundParameter, RoutineParameter } from "./parameter.js";
import type { CallQuery, CommandQuery, Query, RowQuery } from "./query.js";
import type { RoutineCallResult, RoutineContract, RoutineResultFromContract } from "./routine.js";
import type { QueryResultKind, SqlFragment } from "./template-ir.js";

/** Generic SQL tag shape used by configured dialect/query-kind specializations. */
export interface SqlTagLike<Kind extends QueryResultKind = QueryResultKind, Row = unknown> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Query<Row, Kind>;
}

export interface RoutineContractTag<Contract extends RoutineContract> {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): CallQuery<RoutineResultFromContract<Contract>>;
}

/** Row-specialized tag supporting either a TypeScript row type or a Standard Schema mapper. */
export interface RowsTag {
  // Two type parameters keep this overload out of the sql.rows<Row> instantiation expression.
  <Input, Output>(schema: StandardSchemaV1<Input, Output>): SqlTagLike<"rows", Output>;
  <Row = unknown>(strings: TemplateStringsArray, ...values: readonly unknown[]): RowQuery<Row>;
}

/**
 * SQL authoring surface. Values are bound by default; `ident`, `fragment`, `list`, `join`, and `raw` are explicit structure.
 */
export interface SqlTag extends SqlTagLike<"unknown"> {
  /** Declare a row-producing query, optionally with query-bound Standard Schema mapping. */
  rows: RowsTag;
  /** Declare a command query that must normalize to command metadata. */
  command: (strings: TemplateStringsArray, ...values: readonly unknown[]) => CommandQuery;
  /** Declare a routine query, optionally with explicit output/result-set/return mapping contracts. */
  call: {
    <Result extends RoutineCallResult = RoutineCallResult>(
      strings: TemplateStringsArray,
      ...values: readonly unknown[]
    ): CallQuery<Result>;
    <Contract extends RoutineContract>(contract: Contract): RoutineContractTag<Contract>;
  };
  /** Attach explicit database parameter metadata without turning the value into SQL structure. */
  bind<Input>(value: NoInfer<Input>, hint: ParameterTypeHint<Input>): BoundParameter<Input>;
  /** Declare a routine OUT parameter owned by the adapter. */
  out(name: string, hint?: ParameterTypeHint): RoutineParameter<null>;
  /** Declare a routine INOUT parameter owned by the adapter. */
  inOut<Input>(name: string, value: NoInfer<Input>, hint?: ParameterTypeHint<Input>): RoutineParameter<Input>;
  /** Create explicit SQL structure while preserving ordinary interpolations as values. */
  fragment: (strings: TemplateStringsArray, ...values: readonly unknown[]) => SqlFragment;
  /** Empty structural fragment for conditional composition. */
  empty: SqlFragment;
  /** Create a dialect-quoted identifier or qualified identifier path. */
  ident: (identifier: string | readonly string[]) => SqlFragment;
  /** Insert verbatim SQL structure. Never pass user-controlled or otherwise untrusted text. */
  raw: (text: string) => SqlFragment;
  /** Join already-structural fragments with a structural separator. */
  join: (items: readonly SqlFragment[], separator?: SqlFragment) => SqlFragment;
  /** Expand an array as a structural comma-separated list of value binds. */
  list: (values: readonly unknown[]) => SqlFragment;
}
