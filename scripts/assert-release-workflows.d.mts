interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string;
  path: string;
  status: string;
  conclusion: string | null;
  event: string;
}
interface WorkflowContext {
  sha: string;
  ref: string;
  workflow: string;
}
interface WorkflowEvidence extends WorkflowContext {
  runId: number;
}
export declare const requiredReleaseWorkflows: string[];
export declare function successfulExactRun(
  runs: readonly WorkflowRun[],
  context: WorkflowContext,
): WorkflowRun | undefined;
export declare function assertReleaseWorkflows(
  env?: Record<string, string | undefined>,
  request?: (url: URL, init: RequestInit) => Promise<Response>,
): Promise<WorkflowEvidence[]>;
export declare function assertNoPriorStageAttempt(
  env?: Record<string, string | undefined>,
  request?: (url: URL, init: RequestInit) => Promise<Response>,
  options?: { allowReconciliation?: boolean },
): Promise<never[]>;
