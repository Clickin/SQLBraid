export interface ReleaseSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly isPrerelease: boolean;
}

export interface ReleaseEntry {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly dependencies?: readonly string[];
}

export interface ReleaseManifest {
  readonly version: string;
  readonly commit: string;
  readonly runId?: string | null;
  readonly runAttempt?: string | null;
  readonly packages: readonly ReleaseEntry[];
}

export interface StagedPublication {
  readonly format: "sqlbraid-staged-publication";
  readonly mode: "fresh" | "reconcile";
  readonly version: string;
  readonly commit: string;
  readonly runId?: string | null;
  readonly runAttempt?: string | null;
  readonly candidateRunId?: string | null;
  readonly candidateRunAttempt?: string | null;
  readonly manifestSha256: string;
  readonly candidateIdentitySha256: string;
  readonly reconciledFrom?: Readonly<{
    readonly runId?: string | null;
    readonly runAttempt?: string | null;
    readonly manifestSha256: string;
    readonly candidateIdentitySha256?: string;
  }>;
  readonly latestBefore: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly complete: boolean;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly stageId?: string;
    readonly state: "absent" | "pending" | "staged" | "public";
    readonly candidateSha256: string;
    readonly candidateIntegrity: string;
    readonly tag: string;
  }[];
  readonly approvalCommands: readonly { readonly layer: number; readonly command: string }[];
}

export interface ReleaseEvidence {
  readonly format: "sqlbraid-release-evidence";
  readonly version: string;
  readonly commit: string;
  readonly candidate: {
    readonly manifestSha256: string;
    readonly runId: string | null;
    readonly runAttempt: string | null;
    readonly packages: readonly ReleaseEntry[];
  };
  readonly certification: {
    readonly support: {
      readonly file: string;
      readonly sha256: string;
      readonly format: string;
      readonly version: number;
      readonly commit: string;
      readonly run: string | null;
      readonly targetIds: readonly string[];
    };
    readonly targets: readonly { readonly file: string; readonly sha256: string; readonly ids: readonly string[]; readonly commit: string }[];
  };
  readonly publication: {
    readonly packages: readonly {
      readonly name: string;
      readonly version: string;
      readonly state: string;
      readonly stageId: string | null;
      readonly candidateSha256: string;
      readonly candidateIntegrity: string;
      readonly tag: string;
    }[];
    readonly [key: string]: unknown;
  };
}

export declare function assertManifestOrder(manifest: { packages: readonly { name: string }[] }, order: readonly string[]): void;
export declare function assertMutationAuthorization(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertPublicationCredentials(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertTaggedSha(): Promise<string>;
export declare function createReleaseEvidence(
  manifest: ReleaseManifest,
  staged: StagedPublication,
  options?: {
    directory?: string;
    supportEvidencePath?: string;
    targetEvidenceDirectory?: string;
    stagedEvidencePath?: string;
  },
): Promise<ReleaseEvidence>;
export declare function stageCandidates(manifest: ReleaseManifest, options?: {
  dryRun?: boolean;
  directory?: string;
  priorEvidence?: StagedPublication;
  priorRunId?: string;
  currentRunId?: string | null;
  currentRunAttempt?: string | null;
}): Promise<StagedPublication | undefined>;
export declare function verifyPublished(manifest: ReleaseManifest, evidence: StagedPublication, options?: { requireLatest?: boolean }): Promise<void>;
export declare function parseSemver(value: string): ReleaseSemver;
export declare function releasePrereleaseArg(value: string): "--prerelease" | undefined;
export declare function readReleaseManifest(directory?: string, options?: {
  priorCandidateRunId?: string;
  allowCurrentAttemptMismatch?: boolean;
}): Promise<ReleaseManifest>;
export declare function releaseTag(): string;
export declare function setReleaseCommand(command: (file: string, args: readonly string[], cwd?: string, options?: { quiet?: boolean }) => Promise<string>): void;
export declare function setReleaseVersion(version: string): void;
