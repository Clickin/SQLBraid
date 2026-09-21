import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Optional routine identity metadata used by procedure-aware adapters and prepared-shape checks. */
export interface RoutineProcedure {
  readonly name: string;
  readonly parameterNames: readonly string[];
}

export type RoutineSchema = StandardSchemaV1<any, any>;

/**
 * Application mapping contracts for routine OUT values, result sets, and return values.
 * Each channel is independent; an OUT cursor is represented as a result set, not as scalar output.
 */
export interface RoutineContract<
  Output extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Sets extends readonly RoutineSchema[] = readonly RoutineSchema[],
  ReturnValue = unknown,
> {
  readonly output?: StandardSchemaV1<any, Output>;
  readonly resultSets?: Sets;
  readonly returnValue?: StandardSchemaV1<any, ReturnValue>;
  readonly procedure?: RoutineProcedure;
}

/** One materialized routine result set, kept separate from scalar OUT and return-value channels. */
export interface RoutineResultSet<Row = unknown> {
  readonly rows: readonly Row[];
}

export type RoutineResultSetTuple<Sets extends readonly unknown[]> = {
  readonly [K in keyof Sets]: RoutineResultSet<Sets[K]>;
};

/** Application-facing routine result with independent output, result-set, and return-value channels. */
export interface RoutineCallResult<
  Output extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
  Sets extends readonly unknown[] = readonly unknown[],
  ReturnValue = unknown,
> {
  readonly output: Output;
  readonly resultSets: RoutineResultSetTuple<Sets>;
  readonly returnValue?: ReturnValue;
}

export type RoutineSchemaOutput<Schema> = Schema extends StandardSchemaV1<any, infer Output> ? Output : never;

type RoutineRowsFromSchemas<Schemas extends readonly RoutineSchema[]> = {
  readonly [K in keyof Schemas]: RoutineSchemaOutput<Schemas[K]>;
};

export type RoutineResultFromContract<Contract extends RoutineContract> = RoutineCallResult<
  Contract["output"] extends RoutineSchema
    ? RoutineSchemaOutput<Contract["output"]> extends Readonly<Record<string, unknown>>
      ? RoutineSchemaOutput<Contract["output"]>
      : Readonly<Record<string, unknown>>
    : Readonly<Record<string, unknown>>,
  Contract["resultSets"] extends infer Schemas extends readonly RoutineSchema[]
    ? RoutineRowsFromSchemas<Schemas>
    : readonly unknown[],
  Contract["returnValue"] extends RoutineSchema ? RoutineSchemaOutput<Contract["returnValue"]> : unknown
> &
  (Contract extends { readonly returnValue: RoutineSchema }
    ? { readonly returnValue: RoutineSchemaOutput<Contract["returnValue"]> }
    : {});

export type RoutineResultSource =
  | {
      readonly kind: "out-cursor";
      readonly name?: string;
      readonly parameterIndex?: number;
    }
  | {
      readonly kind: "implicit";
      readonly index: number;
    }
  | {
      readonly kind: "emitted";
      readonly index: number;
    };

/** Driver result-set payload with provenance for OUT cursors and emitted/implicit sets. */
export interface DriverRoutineResultSet {
  readonly rows: readonly unknown[];
  readonly source: RoutineResultSource;
}

/** Fully materialized routine result; native cursors, requests, and LOB handles must not escape this boundary. */
export interface DriverRoutineResult {
  readonly output: Readonly<Record<string, unknown>>;
  readonly returnValue?: unknown;
  readonly resultSets: readonly DriverRoutineResultSet[];
}

export type RoutineMappingLocation =
  | { readonly kind: "output" }
  | { readonly kind: "return-value" }
  | {
      readonly kind: "result-set";
      readonly resultSetIndex: number;
      readonly rowIndex: number;
    };

export type DriverCapabilityErrorCode =
  | "BRAID_STREAM_UNSUPPORTED"
  | "BRAID_CALL_UNSUPPORTED"
  | "BRAID_CALL_RESULT_SETS"
  | "BRAID_CALL_CURSOR_TX_REQUIRED"
  | "BRAID_CALL_OUT_UNSUPPORTED"
  | "BRAID_CALL_RETURN_UNSUPPORTED"
  | "BRAID_CALL_CURSOR_UNSUPPORTED"
  | "BRAID_RESOURCE_CLEANUP";

/** Identifies which routine channel or row failed during Standard Schema mapping. */
export class RoutineMappingError extends Error {
  static readonly code = "BRAID_CALL_MAP" as const;
  readonly code = RoutineMappingError.code;
  readonly location: RoutineMappingLocation;

  constructor(message: string, location: RoutineMappingLocation, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RoutineMappingError";
    this.location = Object.freeze(location);
  }
}
