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
  readonly version: string;
  readonly commit: string;
  readonly runId?: string | null;
  readonly runAttempt?: string | null;
  readonly manifestSha256: string;
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

export declare function assertManifestOrder(manifest: { packages: readonly { name: string }[] }, order: readonly string[]): void;
export declare function assertMutationAuthorization(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertPublicationCredentials(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertTaggedSha(): Promise<string>;
export declare function stageCandidates(manifest: ReleaseManifest, options?: { dryRun?: boolean; directory?: string }): Promise<StagedPublication | undefined>;
export declare function verifyPublished(manifest: ReleaseManifest, evidence: StagedPublication, options?: { requireLatest?: boolean }): Promise<void>;
export declare function parseSemver(value: string): ReleaseSemver;
export declare function readReleaseManifest(directory?: string): Promise<ReleaseManifest>;
export declare function releaseTag(): string;
export declare function setReleaseCommand(command: (file: string, args: readonly string[], cwd?: string, options?: { quiet?: boolean }) => Promise<string>): void;
export declare function setReleaseVersion(version: string): void;
