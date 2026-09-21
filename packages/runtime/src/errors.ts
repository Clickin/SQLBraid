import type { StandardSchemaV1, QueryResultKind, RoutineMappingLocation } from "@sqlbraid/core";

/** Raised when `one()` or `maybeOne()` observes too many or too few rows. */
export class DatabaseCardinalityError extends Error {
  readonly expected: "one" | "maybeOne";
  readonly actual: number;

  constructor(expected: "one" | "maybeOne", actual: number) {
    super(`Expected ${expected === "one" ? "exactly one" : "at most one"} row, received ${actual}.`);
    this.name = "DatabaseCardinalityError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Raised when a scoped handle escapes, overlaps its physical resource, or uses a poisoned/closed scope.
 * The code identifies the lifecycle invariant that rejected the operation.
 */
export class DatabaseScopeError extends Error {
  static readonly codes = [
    "BRAID_TX_SCOPE",
    "BRAID_TX_CLOSED",
    "BRAID_SESSION_SCOPE",
    "BRAID_SESSION_CLOSED",
    "BRAID_CONNECTION_POISONED",
    "BRAID_STREAM_SCOPE",
    "BRAID_REENTRY",
    "BRAID_TX_OPTIONS_NESTED",
  ] as const;
  readonly code: (typeof DatabaseScopeError.codes)[number];
  declare readonly cause?: unknown;

  constructor(code: (typeof DatabaseScopeError.codes)[number], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseScopeError";
    this.code = code;
  }
}

/** Raised after execution when the driver result kind disagrees with the query declaration. */
export class DatabaseResultKindError extends Error {
  static readonly code = "BRAID_RESULT_KIND" as const;
  readonly code = DatabaseResultKindError.code;
  readonly declaredKind: QueryResultKind;
  readonly actualKind: "rows" | "command";

  constructor(declaredKind: QueryResultKind, actualKind: "rows" | "command") {
    super(`Declared query result kind "${declaredKind}" did not match actual result kind "${actualKind}".`);
    this.name = "DatabaseResultKindError";
    this.declaredKind = declaredKind;
    this.actualKind = actualKind;
  }
}

/** Raised when a Standard Schema mapper rejects a row, command channel, or routine result channel. */
export class DatabaseResultValidationError extends Error {
  static readonly code = "BRAID_RESULT_VALIDATION" as const;
  readonly code = DatabaseResultValidationError.code;
  readonly issues: readonly StandardSchemaV1.Issue[];
  readonly rowIndex?: number;
  readonly stage: "query" | "execution";
  readonly location?: RoutineMappingLocation;

  constructor(
    issues: readonly StandardSchemaV1.Issue[],
    rowIndex?: number,
    stage: "query" | "execution" = "execution",
    location?: RoutineMappingLocation,
  ) {
    super("Database result validation failed.");
    this.name = "DatabaseResultValidationError";
    this.issues = issues;
    this.rowIndex = rowIndex;
    this.stage = stage;
    this.location = location;
  }
}
