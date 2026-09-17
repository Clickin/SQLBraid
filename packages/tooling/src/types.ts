import type { CodegenResult } from "@sqlbraid/codegen";
import type { CompileDiagnostic, OverlayOptions, SourceRange } from "@sqlbraid/compiler";
import type { MetadataSnapshot } from "@sqlbraid/metadata";

export interface Position {
  readonly line: number;
  readonly character: number;
}
export interface Location {
  readonly uri: string;
  readonly range: { readonly start: Position; readonly end: Position };
}
export interface SourceDocument {
  readonly fileName: string;
  readonly sourceText: string;
  readonly version?: number;
}
export interface ToolingTarget {
  readonly name: string;
  readonly metadata: MetadataSnapshot;
  readonly metadataPath?: string;
  readonly metadataSource?: string;
  readonly outFile?: string;
  readonly generatedSource?: string;
  readonly generation?: CodegenResult;
}
export interface HoverResult {
  readonly contents: string;
  readonly range: SourceRange;
}
export interface CompletionItem {
  readonly label: string;
  readonly kind: "relation" | "column" | "routine";
  readonly detail?: string;
}
export interface QuerySymbol {
  readonly name: string;
  readonly detail: string;
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}
export interface WorkspaceSymbol {
  readonly name: string;
  readonly kind: "relation" | "routine" | "model";
  readonly location: Location;
  readonly detail?: string;
}
export interface SignatureResult {
  readonly label: string;
  readonly parameters: readonly string[];
  readonly activeParameter: number;
}
export interface LanguageServiceOptions extends OverlayOptions {
  readonly metadata?: MetadataSnapshot;
  readonly targets?: readonly ToolingTarget[];
  readonly sources?: readonly SourceDocument[];
  readonly maxEntries?: number;
}
export interface ToolingDiagnostic extends CompileDiagnostic {
  readonly provenance: "braid" | "overlay";
}
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
export interface Cancellation {
  readonly isCancellationRequested: boolean;
}
export interface WorkspaceOptions extends LanguageServiceOptions {
  readonly rootPath: string;
  readonly configPath?: string;
}
export interface ToolingWorkspace {
  setDocument(fileName: string, sourceText: string, version?: number): void;
  closeDocument(fileName: string): void;
  service(cancellation?: Cancellation): Promise<SqlBraidLanguageService>;
  invalidate(): void;
  dispose(): void;
}
