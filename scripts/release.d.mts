export interface ReleaseSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly isPrerelease: boolean;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly commit: string;
  readonly runId?: string | null;
  readonly runAttempt?: string | null;
  readonly packages: readonly { readonly name: string; readonly version: string; readonly file?: string; readonly sha256?: string; readonly integrity?: string }[];
}

export declare function assertManifestOrder(manifest: { packages: readonly { name: string }[] }, order: readonly string[]): void;
export declare function assertMutationAuthorization(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertPublicationCredentials(mode: string, env?: Record<string, string | undefined>): void;
export declare function assertTaggedSha(): Promise<string>;
export declare function assertPnpmIdentityAndWriteAccess(packages: readonly { name: string }[]): Promise<string>;
export declare function pnpmPublish(manifest: ReleaseManifest, options: { dryRun: boolean; provenance: boolean }): Promise<void>;
export declare function parseSemver(value: string): ReleaseSemver;
export declare function readReleaseManifest(directory?: string): Promise<ReleaseManifest>;
export declare function releaseTag(): string;
export declare function setReleaseCommand(command: (file: string, args: readonly string[], cwd?: string, options?: { quiet?: boolean }) => Promise<string>): void;
export declare function setReleaseRequest(request: (url: URL, init?: RequestInit) => Promise<Response>): void;
export declare function setReleaseVersion(version: string): void;
