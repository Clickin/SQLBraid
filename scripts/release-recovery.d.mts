import type { StagedPublication, setReleaseCommand } from "./release.mjs";

export interface RecoveryEvidence {
  readonly tool: {
    readonly repository: string;
    readonly sha: string;
    readonly ref: string;
    readonly runId: string;
    readonly runAttempt: string;
  };
  readonly candidate: {
    readonly sha: string;
    readonly ref: string;
    readonly runId: string;
    readonly runAttempt: string;
  };
  readonly priorRunId: string;
  readonly priorRunAttempt: string;
  readonly rejectedStagesConfirmed: true;
  readonly workflows: readonly { workflow: string; runId: number; sha: string; ref: string }[];
}

export declare function recoverRelease(options: {
  mode: "preflight" | "stage";
  artifactDir: string;
  priorStagedPublication: string;
  env?: Record<string, string | undefined>;
  request?: typeof fetch;
  command?: Parameters<typeof setReleaseCommand>[0];
}): Promise<RecoveryEvidence | (StagedPublication & { recovery: RecoveryEvidence }) | undefined>;
