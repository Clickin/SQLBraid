export interface PolicyMapping {
  readonly databaseType: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly nullable: boolean;
  readonly numeric?: {
    readonly semantics: "exact-integer" | "exact-decimal" | "approximate-binary";
    readonly representation: "string" | "number";
    readonly fidelity: "lossless" | "guarded" | "lossy" | "unsupported";
    readonly binaryPrecision?: 32 | 64;
  };
  readonly [key: string]: unknown;
}

export interface PolicyContractLike {
  readonly id: string;
  readonly mappings: readonly PolicyMapping[];
  readonly decode?: (...args: never[]) => unknown;
  readonly encode?: (...args: never[]) => unknown;
}

export interface TypePolicyLike extends PolicyContractLike {
  readonly hash: string;
}

export interface PolicyRecord {
  readonly packageName: string;
  readonly exportName: string;
  readonly sourcePath: string;
  readonly profileId: string;
  readonly policy: TypePolicyLike;
  readonly profile?: {
    readonly id: string;
    readonly json: "text" | "native";
    readonly temporal: "text" | "native";
    readonly connectionOptions?: Readonly<Record<string, unknown>>;
  };
}

export interface LoadPolicyOptions {
  readonly root?: string;
  readonly packages?: readonly string[];
}

export declare function canonicalPolicyContract(policy: PolicyContractLike): {
  readonly id: string;
  readonly mappings: readonly PolicyMapping[];
};
export declare function canonicalPolicyJson(policy: PolicyContractLike): string;
export declare function typePolicyDigest(policy: PolicyContractLike): string;
export declare function validateTypePolicy(
  policy: TypePolicyLike,
  options?: { readonly expectedHash?: string; readonly requireFrozen?: boolean },
): { readonly id: string; readonly hash: string; readonly mappings: readonly PolicyMapping[] };
export declare function loadFirstPartyPolicies(options?: LoadPolicyOptions): Promise<readonly PolicyRecord[]>;
export declare function validateFirstPartyPolicies(options?: LoadPolicyOptions): Promise<{
  readonly records: readonly PolicyRecord[];
  readonly policies: readonly TypePolicyLike[];
  readonly hashes: readonly string[];
}>;
