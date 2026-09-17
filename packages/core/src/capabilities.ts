/**
 * The machine-readable capability vocabulary shared by adapters, support data,
 * and documentation. A capability's family describes what its status proves;
 * representation and metadata evidence are not execution support aliases.
 */
export type CapabilityFamily = "support" | "representation" | "metadata";

export interface WellKnownCapability {
  readonly id: string;
  readonly family: CapabilityFamily;
}

const definitions = [
  { id: "sql.native-transparency", family: "support" },
  { id: "sql.generated-structure", family: "support" },
  { id: "result.rows", family: "support" },
  { id: "result.command", family: "support" },
  { id: "result.multiple-sets", family: "support" },
  { id: "result.standard-schema", family: "support" },
  { id: "numeric.exact-integer", family: "representation" },
  { id: "numeric.exact-decimal", family: "representation" },
  { id: "numeric.approximate-float", family: "representation" },
  { id: "numeric.approximate-special", family: "representation" },
  { id: "numeric.bind-exact", family: "representation" },
  { id: "numeric.aggregate", family: "representation" },
  { id: "numeric.command-metadata", family: "representation" },
  { id: "numeric.special-values", family: "representation" },
  { id: "numeric.scale-greater-than-precision", family: "representation" },
  { id: "numeric.negative-scale", family: "representation" },
  { id: "data.json-parsed", family: "representation" },
  { id: "data.json-lossless-text", family: "representation" },
  { id: "data.binary", family: "representation" },
  { id: "data.uuid", family: "representation" },
  { id: "data.temporal-native", family: "representation" },
  { id: "data.temporal-lossless", family: "representation" },
  { id: "data.timezone", family: "representation" },
  { id: "metadata.command-safe", family: "metadata" },
  { id: "dml.insert-returning", family: "support" },
  { id: "dml.update-returning", family: "support" },
  { id: "dml.delete-returning", family: "support" },
  { id: "dml.merge-returning", family: "support" },
  { id: "dml.upsert-returning", family: "support" },
  { id: "session.pinned", family: "support" },
  { id: "statement.prepare", family: "support" },
  { id: "statement.cancel", family: "support" },
  { id: "statement.stream", family: "support" },
  { id: "statement.bulk", family: "support" },
  { id: "execution.bulk-fidelity", family: "support" },
  { id: "transaction", family: "support" },
  { id: "transaction.savepoint", family: "support" },
  { id: "transaction.read-only", family: "support" },
  { id: "transaction.isolation.read-uncommitted", family: "support" },
  { id: "transaction.isolation.read-committed", family: "support" },
  { id: "transaction.isolation.repeatable-read", family: "support" },
  { id: "transaction.isolation.serializable", family: "support" },
  { id: "routine.call", family: "support" },
  { id: "routine.out", family: "support" },
  { id: "routine.inout", family: "support" },
  { id: "routine.result-sets", family: "support" },
  { id: "routine.out-cursor", family: "support" },
  { id: "routine.return-value", family: "support" },
  { id: "metadata.identity", family: "metadata" },
  { id: "metadata.generated", family: "metadata" },
  { id: "metadata.routines", family: "metadata" },
  { id: "metadata.types", family: "metadata" },
] as const satisfies readonly WellKnownCapability[];

export const WELL_KNOWN_CAPABILITIES: readonly WellKnownCapability[] = Object.freeze(
  definitions.map((entry) => Object.freeze(entry)),
);

export type WellKnownCapabilityId = (typeof definitions)[number]["id"];

export const WELL_KNOWN_CAPABILITY_IDS: readonly WellKnownCapabilityId[] = Object.freeze(
  definitions.map(({ id }) => id),
);
