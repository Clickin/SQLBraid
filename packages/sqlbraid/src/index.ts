/**
 * Shared SQLBraid types and runtime factories/errors.
 * Import dialects and drivers from their owning @sqlbraid packages.
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
