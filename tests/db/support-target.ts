import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SupportTarget {
  readonly database: {
    readonly product: string;
    readonly version: string;
    readonly edition: string;
  };
  readonly driver: {
    readonly id: string;
    readonly version: string;
    readonly profile: string;
    readonly requiredOptions: Readonly<Record<string, unknown>>;
    readonly driverRawRepresentations: Readonly<Record<string, string>>;
    readonly sqlbraidRepresentations: Readonly<Record<string, string>>;
  };
  readonly runtime: {
    readonly id: string;
    readonly version: string;
  };
  readonly typePolicy: {
    readonly id: string;
    readonly hash: string;
  };
  readonly reproducibility: {
    readonly image?: string;
  };
}

export function supportTarget(targetId: string): SupportTarget {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(targetId)) throw new TypeError(`Invalid support target ID: ${targetId}`);
  const targetUrl = new URL(`../../support/targets/${targetId}.json`, import.meta.url);
  return JSON.parse(readFileSync(targetUrl, "utf8")) as SupportTarget;
}

export function readSupportImage(targetId: string): string {
  const image = supportTarget(targetId).reproducibility.image;
  if (!image) throw new Error(`Support target ${targetId} has no reproducibility image.`);
  return image;
}

export interface SupportEnvironmentObservation {
  readonly database: { readonly product: string; readonly version?: string; readonly edition?: string };
  readonly driver: { readonly id: string; readonly version?: string; readonly profile?: string };
  readonly runtime: { readonly id: string; readonly version?: string };
  readonly typePolicy?: { readonly id: string; readonly hash: string };
}

export interface SupportEnvironmentStamp {
  readonly targetId: string;
  readonly testId?: string;
  readonly database: SupportEnvironmentObservation["database"];
  readonly driver: SupportEnvironmentObservation["driver"];
  readonly runtime: SupportEnvironmentObservation["runtime"];
  readonly typePolicy?: SupportEnvironmentObservation["typePolicy"];
}

/**
 * Record the exact environment observed by a real capability fixture.
 *
 * The optional JSONL sink is intentionally append-only so parallel Vitest
 * projects can stamp independent observations without coordinating state.
 */
export function stampSupportEnvironment(
  targetId: string,
  environment: SupportEnvironmentObservation,
  testId?: string,
): SupportEnvironmentStamp {
  const stamp: SupportEnvironmentStamp = {
    targetId,
    ...(testId ? { testId } : {}),
    database: environment.database,
    driver: environment.driver,
    runtime: environment.runtime,
    ...(environment.typePolicy ? { typePolicy: environment.typePolicy } : {}),
  };
  const directory = process.env.SQLBRAID_SUPPORT_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${targetId}.jsonl`), `${JSON.stringify(stamp)}\n`, "utf8");
  }
  console.info(`[sqlbraid-support] ${JSON.stringify(stamp)}`);
  return stamp;
}
