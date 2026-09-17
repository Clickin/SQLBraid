import type {
  CallQuery,
  CommandQuery,
  Database,
  DatabaseEnvironment,
  EnvironmentCapability,
  RowQuery,
  TransactionIsolation,
} from "@sqlbraid/core";

export const REQUIRED_CASE_IDS = [
  "QRY001", "QRY002", "QRY010", "QRY011", "QRY012", "QRY020", "QRY021", "QRY022", "QRY030", "QRY031", "QRY032",
  "RES001", "RES002", "RES003", "RES004", "RES005", "RES006", "RES007", "RES008", "RES009", "RES010", "RES011",
  "VAL001", "VAL002", "VAL003", "VAL004",
  "SES001", "SES002", "SES003", "SES004", "SES005",
  "SES006", "SES007", "SES008",
  "TX001", "TX002", "TX003", "TX004", "TX005", "TX010", "TX011", "TX012", "TX013", "TX020", "TX021", "TX022", "TX023", "TX024", "TX025", "TX026", "TX027", "TX028", "TX029", "TX030", "TX031", "TX032", "TX033",
  "TX006", "TX007", "TX008", "TX009",
  "PRE001", "PRE002", "PRE003", "PRE004", "PRE005", "PRE006", "PRE007", "PRE008", "PRE009", "PRE010", "PRE011",
  "STR001", "STR002", "STR003", "STR004", "STR005", "STR006", "STR007", "STR008", "STR009",
  "STR010", "STR011",
  "CALL001", "CALL002", "CALL003", "CALL004", "CALL005", "CALL006",
  "CALL007",
  "BULK001", "BULK002", "BULK003", "BULK004", "BAT001", "BAT002", "BAT003",
  "CAP001", "CAP002", "ERR001",
  "STRESS001", "STRESS002", "STRESS003", "STRESS004", "STRESS005", "STRESS006", "STRESS007",
] as const;

export type CertificationCaseId = (typeof REQUIRED_CASE_IDS)[number];
export type CapabilityStatus = EnvironmentCapability["status"];

export const REQUIRED_API_CAPABILITY_IDS = [
  "session.pinned", "transaction", "transaction.savepoint", "transaction.read-only",
  "transaction.isolation.read-uncommitted", "transaction.isolation.read-committed",
  "transaction.isolation.repeatable-read", "transaction.isolation.serializable",
  "statement.prepare", "statement.stream", "statement.cancel", "statement.bulk",
  "routine.call", "routine.out", "routine.inout", "routine.result-sets", "routine.out-cursor", "routine.return-value",
] as const;

export interface ExpectedCapability extends EnvironmentCapability {
  readonly unsupportedCode?: `BRAID_${string}`;
}

export type ExpectedCapabilityContract = Readonly<Record<string, ExpectedCapability>>;

export interface CertificationQueries {
  readonly zero: RowQuery<unknown>;
  readonly one: RowQuery<unknown>;
  readonly many: RowQuery<unknown>;
  readonly command: CommandQuery;
  readonly identity: RowQuery<{ readonly id: string }>;
  readonly failure: RowQuery<unknown>;
  readonly stream?: RowQuery<unknown>;
  readonly fidelity?: {
    readonly largeExactInteger: RowQuery<unknown>;
    readonly exactDecimal: RowQuery<unknown>;
    readonly temporal: RowQuery<unknown>;
    readonly injection: RowQuery<unknown>;
    readonly expected: {
      readonly largeExactInteger: unknown;
      readonly exactDecimal: unknown;
      readonly temporal: unknown;
      readonly injection: unknown;
    };
  };
  readonly special: Readonly<Partial<Record<"RES001" | "RES002" | "RES003" | "RES004" | "RES005" | "RES006" | "RES007" | "RES008" | "RES009" | "RES010" | "RES011", RowQuery<unknown>>>>;
  readonly transaction?: {
    readonly insert: CommandQuery;
    readonly visible: RowQuery<unknown>;
    readonly savepointInsert: CommandQuery;
    readonly savepointVisible: RowQuery<unknown>;
  };
  readonly prepared?: {
    readonly command: (input: unknown) => CommandQuery;
    readonly rows: (input: unknown) => RowQuery<unknown>;
    readonly input: unknown;
    readonly factoryCalls: () => number;
    readonly resources?: () => number;
  };
  readonly routines?: {
    readonly executionScope?: "root" | "transaction";
    readonly call: CallQuery;
    readonly out?: CallQuery;
    readonly inout?: CallQuery;
    readonly resultSets?: CallQuery;
    readonly cursor?: CallQuery;
    readonly returnValue?: CallQuery;
    readonly lob?: CallQuery;
  };
  readonly expected?: {
    readonly one: unknown;
    readonly many: readonly unknown[];
    readonly special: Readonly<Partial<Record<CertificationCaseId, unknown>>>;
    readonly specialErrors?: Readonly<Partial<Record<CertificationCaseId, { readonly code: string; readonly feature?: string }>>>;
    readonly commandAffectedRows?: number;
    readonly failureCode?: string;
    readonly emptyResultError?: {
      readonly feature: string;
      readonly code: `BRAID_${string}`;
    };
  };
}

export interface ExpectedGuardedCaseContract {
  readonly emptyResultError?: {
    readonly feature: string;
    readonly code: `BRAID_${string}`;
  };
}

export interface ResourceSnapshot {
  readonly borrowedLeases: number;
  readonly cleanupBalance: number;
  readonly openCursors?: number;
  readonly openPrepared?: number;
}

export interface CertificationMetrics {
  readonly snapshot: () => Promise<ResourceSnapshot> | ResourceSnapshot;
  readonly sideEffects?: () => number;
  readonly mutationSentinel?: () => Promise<unknown> | unknown;
  readonly physicalSessionIds?: () => readonly string[];
  readonly transactionCleanup?: () => Promise<void>;
  readonly readOnlyWrite?: () => Promise<void>;
  readonly routineCleanup?: (query: CallQuery) => Promise<void>;
  readonly pooledScope?: () => Promise<void>;
}

export interface UnsupportedProbe {
  readonly feature: string;
  readonly expectedErrorFeature?: string;
  readonly expectedCode: `BRAID_${string}`;
  readonly run: () => Promise<unknown>;
  readonly sideEffects: () => number;
}

export interface RepresentationUnsupportedProof {
  readonly prove: () => Promise<void>;
}

export interface CertificationFixture {
  readonly db: Database;
  readonly pooled?: Database;
  readonly queries: CertificationQueries;
  readonly stream?: import("../streaming-conformance.js").StreamingConformanceFixture<unknown>;
  readonly bulk?: import("../bulk-conformance.js").BulkConformanceFixture<unknown>;
  readonly metrics?: CertificationMetrics;
  readonly reset: () => Promise<void>;
  readonly unsupported?: Partial<Record<CertificationCaseId, UnsupportedProbe>>;
  /** Native/lossy proof for non-API capability families (data/numeric/sql/dml/metadata/execution). */
  readonly representationUnsupported?: Partial<Record<string, RepresentationUnsupportedProof>>;
  readonly guarded?: Partial<Record<string, { readonly prove: () => Promise<void> }>>;
  readonly close?: () => Promise<void>;
}

export type TransactionOptionKey =
  | "isolation:read-uncommitted"
  | "isolation:read-committed"
  | "isolation:repeatable-read"
  | "isolation:serializable"
  | "readOnly:true"
  | "readOnly:false"
  | "combination:read-uncommitted+readOnly"
  | "combination:read-uncommitted+readWrite"
  | "combination:read-committed+readOnly"
  | "combination:read-committed+readWrite"
  | "combination:repeatable-read+readOnly"
  | "combination:repeatable-read+readWrite"
  | "combination:serializable+readOnly"
  | "combination:serializable+readWrite";

export interface CertificationTarget {
  readonly id: string;
  readonly sourceSha: string;
  readonly allowCustomCapabilities?: boolean;
  readonly expectedCapabilities: ExpectedCapabilityContract;
  readonly expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">>;
  readonly expectedGuardedCases?: ExpectedGuardedCaseContract;
  readonly createFixture: () => Promise<CertificationFixture>;
}

export interface CertificationCaseResult {
  readonly status: "pass" | "pass-unsupported" | "fail";
  readonly name: string;
  readonly feature?: string;
  readonly rejectionFeature?: string;
  readonly code?: string;
  readonly error?: string;
}

export interface CertificationArtifact {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly sourceSha: string;
  readonly cases: Readonly<Record<CertificationCaseId, CertificationCaseResult>>;
  readonly expectedCapabilities: ExpectedCapabilityContract;
  readonly expectedTransactionOptions: Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">>;
  readonly expectedGuardedCases?: ExpectedGuardedCaseContract;
  readonly declaredCapabilities: Readonly<Record<string, EnvironmentCapability>>;
}

export interface CertificationRunOptions {
  readonly stress?: boolean;
}

export interface CertificationAggregateOptions {
  readonly sourceSha: string;
  readonly requiredTargets: readonly string[];
  readonly requiredTargetContracts: Readonly<Record<string, ExpectedCapabilityContract>>;
  readonly requiredTargetOptionContracts: Readonly<Record<string, Readonly<Record<TransactionOptionKey, "guaranteed" | "unsupported">>>>;
  readonly requiredTargetGuardedCaseContracts?: Readonly<Record<string, ExpectedGuardedCaseContract | undefined>>;
  readonly requiredCaseIds?: readonly CertificationCaseId[];
}

export interface CertificationAggregate {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly targets: Readonly<Record<string, CertificationArtifact>>;
}

export type CertificationIsolation = TransactionIsolation;

export function isCapabilitySupported(capability: ExpectedCapability | undefined): boolean {
  return capability?.status === "guaranteed" || capability?.status === "guarded";
}

export function capabilityDeclaration(environment: DatabaseEnvironment): Readonly<Record<string, EnvironmentCapability>> {
  return environment.capabilities;
}
