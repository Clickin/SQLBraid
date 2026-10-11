import type { DriverEnvironment, ExecutionOptions, TypePolicy } from "@sqlbraid/core";
import { pgEnvironmentFor } from "../pg/environment.js";
import { representationProfiles, typePolicyForProfile } from "../type-policy.js";
import { unsupported } from "./errors.js";

/** The only representation profile that the non-pg adapters support. */
export const losslessProfile = { json: "text", temporal: "text" } as const;
export const losslessPolicy: TypePolicy = representationProfiles[0]!.typePolicy;

export interface LosslessDriver {
  readonly id: string;
  readonly capabilities: DriverEnvironment["capabilities"];
}

export function losslessEnvironmentFor(driver: LosslessDriver, policy: TypePolicy): DriverEnvironment {
  if (policy === losslessPolicy) return pgEnvironmentFor(losslessProfile, losslessPolicy, driver);
  return {
    ...pgEnvironmentFor(losslessProfile, typePolicyForProfile(losslessProfile), driver),
    driver: { id: driver.id, profile: "custom-type-policy" },
    typePolicy: { id: policy.id, hash: policy.hash },
  };
}

/** Reject an active signal before I/O, for drivers that cannot cancel a statement. */
export function rejectActiveSignal(reason: string, options: ExecutionOptions | undefined): void {
  const signal = options?.signal;
  signal?.throwIfAborted();
  if (signal !== undefined) throw unsupported("statement.cancel", "BRAID_CANCEL_UNSUPPORTED", reason);
}
