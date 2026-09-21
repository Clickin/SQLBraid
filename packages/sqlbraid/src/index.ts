/**
 * Application facade: shared SQLBraid contracts plus runtime factories/errors.
 * Driver/dialect-specific execution remains on the explicit facade subpaths.
 */
export * from "@sqlbraid/core";
export {
  createDatabase,
  createPooledDatabase,
  DatabaseCardinalityError,
  DatabaseResultKindError,
  DatabaseResultValidationError,
  DatabaseScopeError,
} from "@sqlbraid/runtime";
