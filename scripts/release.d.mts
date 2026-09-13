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
  readonly packages: readonly { readonly name: string; readonly file?: string; readonly sha256?: string; readonly integrity?: string }[];
}

export declare function assertManifestOrder(manifest: { packages: readonly { name: string }[] }, order: readonly string[]): void;
export declare function assertNpmIdentityAndWriteAccess(packages: readonly { name: string }[]): Promise<string>;
export declare function npmPublish(manifest: ReleaseManifest, options: { dryRun: boolean; provenance: boolean }): Promise<void>;
export declare function npmVersionAtLeast(value: string, minimum: string): boolean;
export declare function parseSemver(value: string): ReleaseSemver;
export declare function releaseTag(): string;
export declare function setReleaseCommand(command: (file: string, args: readonly string[], cwd?: string, options?: { quiet?: boolean; interactive?: boolean }) => Promise<string>): void;
export declare function setReleaseVersion(version: string): void;
