export type { StandardSchemaV1 } from "@standard-schema/spec";

export * from "./errors.js";
export * from "./numeric.js";
export * from "./parameter.js";
export * from "./routine.js";
export * from "./statement.js";
export * from "./binding.js";
export * from "./dialect.js";
export * from "./template-ir.js";
export * from "./query.js";
export * from "./executor.js";
export * from "./observers.js";
export * from "./environment.js";
export * from "./database.js";
export * from "./authoring.js";

export { AUTHORING_MODULE_CATALOG, type AuthoringModuleCatalogEntry } from "./authoring-modules.js";
export {
  isWellKnownCapabilityId,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_CAPABILITY_IDS,
  type CapabilityFamily,
  type WellKnownCapability,
  type WellKnownCapabilityId,
} from "./capabilities.js";
