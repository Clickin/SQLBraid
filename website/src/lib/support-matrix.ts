import manifest from "../../../support/capabilities.json";

export interface LocalizedLabel {
  readonly en: string;
  readonly ko: string;
}

export interface SupportCapability {
  readonly id: string;
  readonly labels: LocalizedLabel;
}

export interface SupportCondition {
  readonly code: string;
  readonly labels: LocalizedLabel;
}

export interface TargetCapability {
  readonly status: string;
  readonly conditionCode?: string;
  readonly testIds?: readonly string[];
  readonly canonical?: string;
  readonly rawRepresentations?: readonly string[];
}

export interface SupportTarget {
  readonly id: string;
  readonly status: string;
  readonly database: {
    readonly product: string;
    readonly version?: string;
    readonly edition?: string;
  };
  readonly driver: {
    readonly id: string;
    readonly version?: string;
    readonly profile?: string;
    readonly package?: string;
    readonly transport?: string;
    readonly stream?: string;
    readonly routine?: string;
    readonly bulk?: string;
    readonly rawRepresentations?: Readonly<Record<string, string>>;
    readonly exclusions?: readonly string[];
  };
  readonly runtime: { readonly id: string; readonly version?: string };
  readonly reproducibility?: { readonly zeroCost?: boolean; readonly description?: string; readonly url?: string };
  readonly ci?: { readonly command?: string; readonly workflow?: string; readonly releaseBlocking?: boolean };
  readonly capabilities: Readonly<Record<string, TargetCapability>>;
  readonly evidence?: { readonly status?: string; readonly commit?: string; readonly runs?: readonly string[] };
}

export interface SupportManifest {
  readonly capabilities: readonly SupportCapability[];
  readonly conditions: readonly SupportCondition[];
}

export interface SupportMatrixData extends SupportManifest {
  readonly targets: readonly SupportTarget[];
}

const targetModules = import.meta.glob<SupportTarget>("../../../support/targets/*.json", { eager: true, import: "default" });

/** Read the build-time manifest shared by CI and the documentation UI. */
export function loadSupportMatrix(): SupportMatrixData {
  const targets = Object.keys(targetModules).sort().map((name) => targetModules[name]!);
  return { ...manifest, targets };
}

/** Safe for an application/json script: JSON cannot terminate the script or create markup. */
export function serializeSupportMatrix(data: SupportMatrixData): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

