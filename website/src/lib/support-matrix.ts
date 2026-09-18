import manifest from "../../../support/capabilities.json" with { type: "json" };

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
  readonly semantics?: "exact-integer" | "exact-decimal" | "approximate-binary";
  readonly representation?: "string" | "number";
  readonly fidelity?: "lossless" | "guarded" | "lossy" | "unsupported";
  readonly binaryPrecision?: 32 | 64;
  readonly driverRawRepresentations?: readonly string[];
}

export interface NumericContract {
  readonly semantics: "exact-integer" | "exact-decimal" | "approximate-binary";
  readonly representation: "string" | "number";
  readonly fidelity: "lossless" | "guarded" | "lossy" | "unsupported";
  readonly binaryPrecision?: 32 | 64;
  readonly profile?: string;
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
    readonly requiredOptions?: unknown;
    readonly driverRawRepresentations?: Readonly<Record<string, string>>;
    readonly sqlbraidRepresentations?: Readonly<Record<string, string>>;
    readonly exclusions?: readonly string[];
  };
  readonly runtime: { readonly id: string; readonly version?: string };
  readonly reproducibility?: { readonly zeroCost?: boolean; readonly description?: string; readonly url?: string };
  readonly ci?: { readonly command?: string; readonly workflow?: string; readonly releaseBlocking?: boolean };
  readonly numeric: Readonly<Record<"exact-integer" | "exact-decimal" | "approximate-binary", NumericContract>>;
  readonly containers: Readonly<Record<string, "lossless" | "unclassified" | "unsupported">>;
  readonly capabilities: Readonly<Record<string, TargetCapability>>;
  readonly typePolicy?: { readonly id: string; readonly hash: string };
  readonly evidence?: { readonly status?: string; readonly commit?: string };
}

export interface SupportManifest {
  readonly capabilities: readonly SupportCapability[];
  readonly conditions: readonly SupportCondition[];
}

export interface SupportMatrixData extends SupportManifest {
  readonly targets: readonly SupportTarget[];
}

export type SupportMatrixView = "database" | "driver" | "capability";
export type SupportMatrixLocale = "en" | "ko";

export interface SupportMatrixRow {
  readonly target: SupportTarget;
  readonly capabilityId?: string;
  readonly capability?: TargetCapability;
}

const labels = {
  en: {
    database: "Database",
    driver: "Driver",
    capability: "Capability",
    version: "Version",
    runtime: "Runtime",
    status: "Support status",
    target: "Target",
    profile: "Profile",
    integer: "Driver raw integer",
    decimal: "Driver raw decimal",
    json: "JSON",
    temporal: "Temporal",
    rawJson: "Driver raw JSON",
    rawTemporal: "Driver raw temporal",
    canonical: "SQLBraid canonical",
    policy: "TypePolicy",
    options: "Required options",
    stream: "Streaming",
    routine: "Routines",
    bulk: "Bulk",
    exclusions: "Excluded profiles",
    condition: "Condition",
    test: "Test ID",
    ci: "CI gate",
    exactNumeric: "Exact numeric",
    approximate: "Approximate float",
    transaction: "Transaction",
  },
  ko: {
    database: "데이터베이스",
    driver: "드라이버",
    capability: "기능",
    version: "버전",
    runtime: "런타임",
    status: "지원 상태",
    target: "대상",
    profile: "프로필",
    integer: "드라이버 원시 정수",
    decimal: "드라이버 원시 소수",
    json: "JSON",
    temporal: "시간",
    rawJson: "드라이버 원시 JSON",
    rawTemporal: "드라이버 원시 시간",
    canonical: "SQLBraid 표준 표현",
    policy: "TypePolicy",
    options: "필수 옵션",
    stream: "스트리밍",
    routine: "루틴",
    bulk: "벌크",
    exclusions: "제외 프로필",
    condition: "조건",
    test: "테스트 ID",
    ci: "CI 게이트",
    exactNumeric: "정확한 숫자",
    approximate: "근사 부동소수점",
    transaction: "트랜잭션",
  },
} as const;

const statuses: Record<string, readonly [string, string]> = {
  official: ["Official", "공식"],
  conditional: ["Conditional", "조건부"],
  compatible: ["Compatible", "호환 가능"],
  historical: ["Historical", "과거 검증"],
  unsupported: ["Unsupported", "지원하지 않음"],
  guaranteed: ["Guaranteed", "보장됨"],
  guarded: ["Guarded", "값 검사"],
  pending: ["Pending", "검증 대기"],
};

export function supportMatrixStatus(value: string, locale: SupportMatrixLocale): string {
  return statuses[value.toLowerCase()]?.[locale === "ko" ? 1 : 0] ?? value;
}

export function supportMatrixCapabilityLabel(data: SupportMatrixData, id: string, locale: SupportMatrixLocale): string {
  return data.capabilities.find((capability) => capability.id === id)?.labels[locale] ?? id;
}

function conditionLabel(data: SupportMatrixData, code: string | undefined, locale: SupportMatrixLocale): string {
  return code ? (data.conditions.find((condition) => condition.code === code)?.labels[locale] ?? code) : "—";
}

function capabilitySummary(
  data: SupportMatrixData,
  target: SupportTarget,
  prefix: string,
  locale: SupportMatrixLocale,
): string {
  const entries = Object.entries(target.capabilities).filter(([id]) => id === prefix || id.startsWith(`${prefix}.`));
  return (
    entries
      .map(
        ([id, claim]) =>
          `${entries.length > 1 ? `${supportMatrixCapabilityLabel(data, id, locale)}: ` : ""}${supportMatrixStatus(claim.status, locale)}${claim.conditionCode ? ` (${conditionLabel(data, claim.conditionCode, locale)})` : ""}`,
      )
      .join("; ") || "—"
  );
}

function numericLabel(target: SupportTarget, kind: keyof SupportTarget["numeric"]): string {
  const contract = target.numeric[kind];
  if (!contract) return "—";
  const precision = contract.binaryPrecision === undefined ? "" : `/${contract.binaryPrecision}`;
  return `${contract.representation} · ${contract.fidelity}${precision}${contract.profile ? ` · ${contract.profile}` : ""}`;
}

function targetDatabaseLabel(target: SupportTarget): string {
  return [target.database.product, target.database.version, target.database.edition].filter(Boolean).join(" ");
}

function targetDriverLabel(target: SupportTarget): string {
  return `${target.driver.id}${target.driver.version ? `@${target.driver.version}` : ""}`;
}

function targetRuntimeLabel(target: SupportTarget): string {
  return `${target.runtime.id}${target.runtime.version ? `@${target.runtime.version}` : ""}`;
}

export function supportMatrixColumns(view: SupportMatrixView, locale: SupportMatrixLocale): readonly string[] {
  const l = labels[locale];
  if (view === "database") {
    return [
      l.target,
      l.database,
      l.driver,
      l.runtime,
      l.status,
      l.exactNumeric,
      l.json,
      l.temporal,
      l.transaction,
      l.stream,
    ];
  }
  if (view === "driver") {
    return [
      l.driver,
      l.version,
      l.target,
      l.runtime,
      l.profile,
      l.integer,
      l.decimal,
      l.rawJson,
      l.rawTemporal,
      l.canonical,
      l.policy,
      l.options,
      l.stream,
      l.routine,
      l.bulk,
      l.exclusions,
    ];
  }
  return [l.capability, l.target, l.status, l.condition, l.test, l.ci];
}

/** Project one visible row into the stable, semantic columns used by the matrix. */
export function projectSupportMatrixRow(
  data: SupportMatrixData,
  view: SupportMatrixView,
  row: SupportMatrixRow,
  locale: SupportMatrixLocale,
): readonly string[] {
  const target = row.target;
  if (view === "capability") {
    const capability = row.capability!;
    return [
      supportMatrixCapabilityLabel(data, row.capabilityId!, locale),
      target.id,
      supportMatrixStatus(capability.status, locale),
      conditionLabel(data, capability.conditionCode, locale),
      capability.testIds?.join(", ") ?? "—",
      [target.ci?.command, target.ci?.workflow].filter(Boolean).join(" · ") || "—",
    ];
  }
  if (view === "driver") {
    const raw = target.driver.driverRawRepresentations ?? {};
    const canonical = target.driver.sqlbraidRepresentations ?? {};
    const policy = target.typePolicy;
    return [
      target.driver.id,
      target.driver.version ?? "—",
      target.id,
      targetRuntimeLabel(target),
      target.driver.profile ?? "—",
      raw.integer ?? "—",
      raw.decimal ?? "—",
      raw.json ?? "—",
      raw.temporal ?? "—",
      [canonical.integer, canonical.decimal, canonical.json, canonical.temporal].filter(Boolean).join(" · ") || "—",
      policy ? `${policy.id}@${policy.hash}` : "—",
      target.driver.requiredOptions === undefined ? "—" : JSON.stringify(target.driver.requiredOptions),
      target.driver.stream ?? "—",
      target.driver.routine ?? "—",
      target.driver.bulk ?? "—",
      target.driver.exclusions?.join(", ") ?? "—",
    ];
  }
  return [
    target.id,
    targetDatabaseLabel(target),
    targetDriverLabel(target),
    targetRuntimeLabel(target),
    supportMatrixStatus(target.status, locale),
    [numericLabel(target, "exact-integer"), numericLabel(target, "exact-decimal")].join(" / "),
    [
      capabilitySummary(data, target, "data.json-parsed", locale),
      capabilitySummary(data, target, "data.json-lossless-text", locale),
    ]
      .filter((value) => value !== "—")
      .join(" / ") || "—",
    [
      capabilitySummary(data, target, "data.temporal-native", locale),
      capabilitySummary(data, target, "data.temporal-lossless", locale),
    ]
      .filter((value) => value !== "—")
      .join(" / ") || "—",
    capabilitySummary(data, target, "transaction", locale),
    capabilitySummary(data, target, "statement.stream", locale),
  ];
}

const targetModules = (
  import.meta as ImportMeta & {
    glob<T>(pattern: string, options?: { eager?: boolean; import?: string }): Record<string, T>;
  }
).glob<SupportTarget>("../../../support/targets/*.json", { eager: true, import: "default" });

/** Read the build-time manifest shared by CI and the documentation UI. */
export function loadSupportMatrix(): SupportMatrixData {
  const targets = Object.keys(targetModules)
    // eslint-disable-next-line unicorn/no-array-sort -- Object.keys() produces an owned temporary array.
    .sort()
    .map((name) => targetModules[name]!);
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
