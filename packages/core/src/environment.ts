import type { RenderedStatement } from "./statement.js";

export interface EnvironmentCapability {
  readonly status: "guaranteed" | "guarded" | "unsupported";
  readonly canonical?: "string" | "number" | "Uint8Array";
  readonly rawRepresentations?: readonly string[];
  readonly conditionCode?: string;
}

/** Observed database/driver/runtime evidence plus exact support-target matching. */
export interface DatabaseEnvironment {
  readonly database: { readonly product: string; readonly version?: string; readonly edition?: string };
  readonly driver: { readonly id: string; readonly version?: string; readonly profile?: string };
  readonly runtime: { readonly id: string; readonly version?: string };
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly capabilities: Readonly<Record<string, EnvironmentCapability>>;
  readonly supportMatch: {
    readonly status: "official" | "conditional" | "compatible";
    readonly targetId?: string;
    readonly reason?: string;
  };
}

/** Adapter evidence only. Probes run through the ordinary observed, leased query path. */
export interface DriverEnvironment {
  readonly database: DatabaseEnvironment["database"];
  readonly driver: DatabaseEnvironment["driver"];
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly capabilities: DatabaseEnvironment["capabilities"];
  readonly probe?: {
    readonly statement: RenderedStatement;
    readonly read: (rows: readonly unknown[]) => {
      readonly version?: string;
      readonly edition?: string;
      readonly capabilities?: Readonly<Record<string, EnvironmentCapability>>;
    };
  };
}

/** Structural subset of a support manifest; importing support tooling is unnecessary. */
export interface EnvironmentSupportTarget {
  readonly id: string;
  readonly status: string;
  readonly database: { readonly product: string; readonly version: string; readonly edition: string };
  readonly driver: { readonly id: string; readonly version: string; readonly profile: string };
  readonly runtime: { readonly id: string; readonly version: string };
  readonly typePolicy: { readonly id: string; readonly hash: string };
  readonly evidence: { readonly status: string };
}

export interface EnvironmentOptions {
  readonly targets?: readonly EnvironmentSupportTarget[];
  /** Re-probe the current lease instead of returning the cached observation. */
  readonly refresh?: boolean;
}
