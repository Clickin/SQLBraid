import type { CodegenResult } from "@sqlbraid/codegen";
import type { CompileDiagnostic, OverlayOptions, SourceRange } from "@sqlbraid/compiler";
import type { MetadataSnapshot } from "@sqlbraid/metadata";

/** Zero-based text position used by tooling/LSP consumers. */
export interface Position {
  readonly line: number;
  readonly character: number;
}
/** URI plus half-open source range for navigation results. */
export interface Location {
  readonly uri: string;
  readonly range: { readonly start: Position; readonly end: Position };
}
/** In-memory source snapshot; `version` is optional for non-editor callers. */
export interface SourceDocument {
  readonly fileName: string;
  readonly sourceText: string;
  readonly version?: number;
}
/** Metadata/codegen evidence target used for definitions, hover, and generated-model navigation. */
export interface ToolingTarget {
  readonly name: string;
  readonly metadata: MetadataSnapshot;
  readonly metadataPath?: string;
  readonly metadataSource?: string;
  readonly outFile?: string;
  readonly generatedSource?: string;
  readonly generation?: CodegenResult;
}
/** Rendered hover content and its source range. */
export interface HoverResult {
  readonly contents: string;
  readonly range: SourceRange;
}
/** Static SQL completion item; `${...}` expressions are intentionally outside this surface. */
export interface CompletionItem {
  readonly label: string;
  readonly kind: "relation" | "column" | "routine";
  readonly detail?: string;
}
/** One query symbol discovered in a source document. */
export interface QuerySymbol {
  readonly name: string;
  readonly detail: string;
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}
/** Workspace-wide relation/routine/model symbol location. */
export interface WorkspaceSymbol {
  readonly name: string;
  readonly kind: "relation" | "routine" | "model";
  readonly location: Location;
  readonly detail?: string;
}
/** Routine signature help with the active parameter index. */
export interface SignatureResult {
  readonly label: string;
  readonly parameters: readonly string[];
  readonly activeParameter: number;
}
/** Language-service inputs; metadata is positive evidence and a miss remains unresolved. */
export interface LanguageServiceOptions extends OverlayOptions {
  readonly metadata?: MetadataSnapshot;
  readonly targets?: readonly ToolingTarget[];
  readonly sources?: readonly SourceDocument[];
  readonly maxEntries?: number;
}
/** Diagnostic provenance distinguishes compiler/Braid diagnostics from TypeScript overlay diagnostics. */
export interface ToolingDiagnostic extends CompileDiagnostic {
  readonly provenance: "braid" | "overlay";
}
/**
 * SQL-aware semantic service. Results are lexical/metadata-backed and do not replace native TypeScript semantics.
 * `reload()` returns a new service with the supplied metadata snapshot.
 */
export interface SqlBraidLanguageService {
  diagnostics(sourceText: string, fileName: string): readonly ToolingDiagnostic[];
  hover(sourceText: string, fileName: string, offset: number): HoverResult | undefined;
  complete(sourceText: string, fileName: string, offset: number): readonly CompletionItem[];
  definition(sourceText: string, fileName: string, offset: number): Location | undefined;
  references(
    sourceText: string,
    fileName: string,
    offset: number,
    cancellation?: Cancellation,
  ): Promise<readonly Location[]>;
  documentSymbols(sourceText: string, fileName: string): readonly QuerySymbol[];
  workspaceSymbols(query: string): readonly WorkspaceSymbol[];
  signatureHelp(sourceText: string, fileName: string, offset: number): SignatureResult | undefined;
  reload(metadata: MetadataSnapshot): SqlBraidLanguageService;
}
/** Cooperative cancellation flag checked between bounded tooling phases. */
export interface Cancellation {
  readonly isCancellationRequested: boolean;
}
/** Workspace root/config inputs; caches are owned by the resulting workspace. */
export interface WorkspaceOptions extends LanguageServiceOptions {
  readonly rootPath: string;
  readonly configPath?: string;
}
/** Mutable workspace facade; callers must dispose it to release caches and pending work. */
export interface ToolingWorkspace {
  setDocument(fileName: string, sourceText: string, version?: number): void;
  closeDocument(fileName: string): void;
  service(cancellation?: Cancellation): Promise<SqlBraidLanguageService>;
  invalidate(): void;
  dispose(): void;
}
